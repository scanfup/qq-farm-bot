// 导出运行时捕获的明文响应
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('out/proto', { recursive: true });

const PORT = process.env.CDP_PORT || 62000;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let id = 0; const pending = new Map();
function send(m, p) {
  const mid = ++id;
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout')); } }, 20000);
  });
}
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');

const script = `(() => {
  const a = globalThis.__t2_full;
  if (!a) return null;
  let s=''; for (const b of a) s += b.toString(16).padStart(2,'0');
  return s;
})()`;

const r = await send('Runtime.evaluate', {
  expression: script,
  contextId: 3,
  returnByValue: true,
});

const hex = r.result?.value;
if (!hex) { console.log('[fail] __t2_full 不存在（页面可能已刷新）'); }
else {
  const buf = Buffer.from(hex, 'hex');
  writeFileSync('out/proto/AllLandsReply.hex', hex);
  writeFileSync('out/proto/AllLandsReply.bin', buf);
  console.log(`[ok] AllLandsReply len=${buf.length} -> out/proto/AllLandsReply.bin`);
  // 提取可读中文
  const txt = buf.toString('utf8').replace(/[\x00-\x1f]/g, ' ');
  console.log('[strings]', txt.match(/[\u4e00-\u9fa5]{2,}/g)?.slice(0, 30).join(' | '));
}
ws.close(); process.exit(0);
