// 外部挂机调用工具：CDP → __bot.call → 游戏网络层
// 用法:
//   node tools/bot.mjs status
//   node tools/bot.mjs call <service> <method> [bodyHex]
//   node tools/bot.mjs raw  <service> <method> [bodyHex]
//
// 注意：每次调用会用 __bot 注入层；若页面已刷新，先跑 tools/grab-net.mjs
import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 62000;
const CTX = Number(process.env.CDP_CTX || 3);
const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let id = 0;
const pending = new Map();
function send(method, params) {
  const mid = ++id;
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 30000);
  });
}
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
});
ws.addEventListener('error', (e) => { console.log('[ws-error]', e.message || 'unknown'); });
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');

async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression, contextId: CTX, returnByValue: true, awaitPromise,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  }
  return r.result?.value;
}

// 确保适配层存在
const hasBot = await evaluate('typeof globalThis.__bot === "object" && !!globalThis.__bot');
if (!hasBot) {
  const inj = readFileSync(new URL('./probe/inject_bot.js', import.meta.url), 'utf8');
  const r = await evaluate(inj);
  console.log('[inject]', r);
}

if (cmd === 'status') {
  const s = await evaluate('JSON.stringify(globalThis.__bot ? globalThis.__bot.status() : null)');
  console.log(JSON.stringify(JSON.parse(s || 'null'), null, 1));

} else if (cmd === 'call' || cmd === 'raw') {
  const service = argv[1], method = argv[2], bodyHex = argv[3] || '';
  if (!service || !method) { console.log('usage: node tools/bot.mjs call <service> <method> [bodyHex]'); process.exit(1); }
  if (cmd === 'call') {
    const expr = `globalThis.__bot.call(${JSON.stringify(service)},${JSON.stringify(method)},${JSON.stringify(bodyHex)}).then(r=>JSON.stringify(r))`;
    const out = await evaluate(expr, true);
    const o = JSON.parse(out);
    console.log('[meta]', JSON.stringify(o.meta));
    console.log('[ok]', o.ok, 'bodyLen =', o.bodyLen, o.err ? 'err=' + o.err : '');
    if (o.bodyHex) {
      const buf = Buffer.from(o.bodyHex, 'hex');
      console.log('[hex]', o.bodyHex.slice(0, 400) + (o.bodyHex.length > 400 ? '…' : ''));
      const strs = buf.toString('utf8').match(/[\u4e00-\u9fa5]{2,}/g);
      if (strs) console.log('[中文]', strs.slice(0, 20).join(' | '));
    }
  } else {
    const expr = `globalThis.__bot.raw(${JSON.stringify(service)},${JSON.stringify(method)},${JSON.stringify(bodyHex)})`;
    console.log('[raw sent]', await evaluate(expr));
  }
}
ws.close();
process.exit(0);
