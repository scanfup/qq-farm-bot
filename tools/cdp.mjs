// CDP 客户端：连 127.0.0.1:62000，列 contexts / 执行表达式
// 用法:
//   node tools/cdp.mjs --list
//   node tools/cdp.mjs --eval "<js>" [--ctx N]
//   node tools/cdp.mjs --eval-all "<js>"
//   node tools/cdp.mjs --file probe.js [--ctx N]      # 从文件读表达式（推荐，免转义）
//   node tools/cdp.mjs --file-all probe.js
import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 62000;
const URL = `ws://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const mode = argv.includes('--list') ? 'list'
  : argv.includes('--file-all') ? 'eval-all'
    : argv.includes('--file') ? 'eval'
      : argv.includes('--eval-all') ? 'eval-all'
        : argv.includes('--eval') ? 'eval' : 'list';
const ctxIdx = argv.indexOf('--ctx');
const ctxArg = ctxIdx >= 0 ? Number(argv[ctxIdx + 1]) : null;
let expr = '';
const fileIdx = argv.indexOf('--file-all') >= 0 ? argv.indexOf('--file-all') : argv.indexOf('--file');
if (fileIdx >= 0) {
  expr = readFileSync(argv[fileIdx + 1], 'utf8');
} else {
  const evalIdx = argv.indexOf('--eval-all') >= 0 ? argv.indexOf('--eval-all') : argv.indexOf('--eval');
  expr = evalIdx >= 0 ? argv[evalIdx + 1] : '';
}

const IGNORE = /^(node:|internal\/|devtools:\/\/)/;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}

function makeClient(ws) {
  let id = 0;
  const pending = new Map();
  const contexts = [];
  const scripts = [];

  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
    if (m.method === 'Debugger.scriptParsed' && !IGNORE.test(m.params.url || '')) scripts.push(m.params);
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout: ' + method)); } }, 15000);
  });

  return { send, contexts, scripts };
}

async function evaluate(client, expression, contextId) {
  const params = { expression, returnByValue: true, awaitPromise: true, generatePreview: false };
  if (contextId != null) params.contextId = contextId;
  try {
    const r = await client.send('Runtime.evaluate', params);
    if (r.exceptionDetails) {
      return { error: r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails).slice(0, 500) };
    }
    return { value: r.result?.value, type: r.result?.type, desc: r.result?.description };
  } catch (e) {
    return { error: e.message };
  }
}

const ws = await connect();
const client = makeClient(ws);
await client.send('Runtime.enable');

// 给事件一点时间到达
await new Promise(r => setTimeout(r, 1200));

if (mode === 'list') {
  console.log('=== executionContexts ===');
  for (const c of client.contexts) {
    console.log(`id=${c.id}  origin=${c.origin}  name="${c.name}"  frameId=${c.auxData?.frameId}  type=${c.auxData?.type}`);
  }
  console.log('\n=== non-node scripts (first 60) ===');
  for (const s of client.scripts.slice(0, 60)) {
    console.log(`len=${String(s.length).padStart(8)}  ctx=${s.executionContextId}  ${(s.url || '(inline)').slice(0, 130)}`);
  }
  console.log('\ntotal non-node scripts =', client.scripts.length);

} else if (mode === 'eval') {
  const r = await evaluate(client, expr, ctxArg);
  console.log(JSON.stringify(r, null, 2));

} else if (mode === 'eval-all') {
  for (const c of client.contexts) {
    console.log(`\n########## context id=${c.id} (frame=${c.auxData?.frameId}) ##########`);
    const r = await evaluate(client, expr, c.id);
    console.log(JSON.stringify(r, null, 2).slice(0, 4000));
  }
}

ws.close();
process.exit(0);
