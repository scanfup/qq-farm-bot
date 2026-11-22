// First MCP 客户端（SSE 传输）
// 用法:
//   node tools/mcp.mjs tools
//   node tools/mcp.mjs call <tool> '{"k":"v"}'
//   node tools/mcp.mjs raw <method> '{"k":"v"}'
const BASE = process.env.MCP_BASE || 'http://127.0.0.1:4554';

let reader = null;
let endpoint = null;
let buf = '';
let seq = 0;
const pending = new Map();
const events = [];

function handleBlock(block) {
  const lines = block.split(/\r?\n/);
  let event = 'message', data = '';
  for (const l of lines) {
    if (l.startsWith('event:')) event = l.slice(6).trim();
    else if (l.startsWith('data:')) data += l.slice(5).trim();
  }
  if (event === 'endpoint') { endpoint = data; return; }
  if (!data) return;
  try {
    const j = JSON.parse(data);
    if (j.id !== undefined && pending.has(j.id)) {
      const fn = pending.get(j.id); pending.delete(j.id);
      fn(j);
    } else {
      events.push(j);
    }
  } catch (e) { /* 忽略非 JSON */ }
}

async function startSSE() {
  const res = await fetch(BASE + '/sse', { headers: { Accept: 'text/event-stream' } });
  if (!res.ok) throw new Error('SSE 连接失败 HTTP ' + res.status);
  reader = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let m;
        while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
          const block = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          handleBlock(block);
        }
      }
    } catch (e) { /* 流关闭 */ }
  })();
  const t0 = Date.now();
  while (!endpoint && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 50));
  if (!endpoint) throw new Error('未收到 endpoint 事件');
}

async function postal(method, params) {
  const id = ++seq;
  const p = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('rpc timeout: ' + method)); } }, 40000);
  });
  const url = BASE + endpoint;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
  });
  if (!res.ok) throw new Error('POST ' + method + ' -> HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return p;
}

async function notify(method, params) {
  await fetch(BASE + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }),
  });
}

async function handshake() {
  await startSSE();
  const init = await postal('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh', version: '1.0' },
  });
  await notify('notifications/initialized');
  return init;
}

// 干净退出：取消 SSE 流，避免 node 退出时的 uv_handle 断言
async function done(code = 0) {
  try { if (reader) await reader.cancel(); } catch (e) { }
  await new Promise(r => setTimeout(r, 80));
  process.exit(code);
}

const mode = process.argv[2] || 'tools';

if (mode === 'tools') {
  const init = await handshake();
  console.log('[initialize] server:', JSON.stringify(init.result?.serverInfo || {}));
  console.log('[capabilities]', JSON.stringify(init.result?.capabilities || {}));
  const r = await postal('tools/list');
  const tools = r.result?.tools || [];
  console.log(`\n=== 可用工具 ${tools.length} 个 ===`);
  for (const t of tools) {
    console.log(`\n● ${t.name}`);
    if (t.description) console.log(`   ${String(t.description).replace(/\s+/g, ' ').slice(0, 260)}`);
    const props = t.inputSchema?.properties || {};
    const keys = Object.keys(props);
    if (keys.length) {
      console.log('   参数:');
      for (const k of keys) {
        const p = props[k];
        const req = (t.inputSchema.required || []).includes(k) ? '必填' : '可选';
        console.log(`     - ${k} (${p.type || '?'}, ${req}) ${String(p.description || '').slice(0, 90)}`);
      }
    } else {
      console.log('   参数: (无)');
    }
  }
  await done(0);
}

if (mode === 'eval' || mode === 'evalall') {
  const expr = process.argv[3];
  if (!expr) { console.log('usage: node tools/mcp.mjs eval "<expr>" [context_id]  |  evalall "<expr>"'); await done(1); }
  await handshake();

  let ctxIds = [null];
  if (mode === 'evalall') {
    const lr = await postal('tools/call', { name: 'miniapp_list_contexts', arguments: {} });
    const txt = (lr.result?.content || []).find(c => c.type === 'text')?.text || '{}';
    try {
      const j = JSON.parse(txt);
      ctxIds = (j.contexts || []).map(c => c.id);
      if (!ctxIds.length) ctxIds = [null];
    } catch (e) { }
  } else if (process.argv[4] !== undefined) {
    ctxIds = [Number(process.argv[4])];
  }

  for (const cid of ctxIds) {
    const args = { expression: expr };
    if (cid !== null) args.context_id = cid;
    let out = '';
    try {
      const r = await postal('tools/call', { name: 'miniapp_evaluate', arguments: args });
      out = (r.result?.content || []).map(c => c.text ?? JSON.stringify(c)).join('\n');
      if (r.error) out = '[error] ' + JSON.stringify(r.error);
    } catch (e) { out = '[err] ' + e.message; }
    console.log(`--- ctx ${cid === null ? 'default' : cid} ---`);
    console.log(String(out).slice(0, 2500));
    console.log('');
  }
  await done(0);
}

if (mode === 'call' || mode === 'raw') {
  const name = process.argv[3];
  const params = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  await handshake();
  const r = mode === 'call'
    ? await postal('tools/call', { name, arguments: params })
    : await postal(name, params);
  if (r.error) { console.log('[error]', JSON.stringify(r.error, null, 1)); process.exit(1); }
  const content = r.result?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text') console.log(c.text);
      else console.log(JSON.stringify(c).slice(0, 3000));
    }
  } else {
    console.log(JSON.stringify(r.result, null, 1).slice(0, 6000));
  }
  await done(0);
}
