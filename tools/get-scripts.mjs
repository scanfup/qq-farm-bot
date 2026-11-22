// 获取游戏脚本源码并保存到本地，便于离线搜索分析
// 用法: node tools/get-scripts.mjs <substr> [outdir]
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 62000;
const NEEDLE = process.argv[2] || 'game.js';
const OUTDIR = process.argv[3] || 'ref/game-src';
mkdirSync(OUTDIR, { recursive: true });

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let id = 0;
const pending = new Map();
const scripts = [];

function send(method, params) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 60000);
  });
}

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Debugger.scriptParsed') scripts.push(m.params);
});
ws.addEventListener('error', (e) => console.log('[ws-error]', e.message || 'unknown'));
await new Promise(r => ws.addEventListener('open', r));
await send('Debugger.enable');
await new Promise(r => setTimeout(r, 1500));

const hits = scripts.filter(s => (s.url || '').includes(NEEDLE));
console.log(`[match] "${NEEDLE}" -> ${hits.length} scripts (总 ${scripts.length})`);

const index = [];
for (const s of hits) {
  const name = (s.url || 'inline').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const file = `${OUTDIR}/${name}.${s.scriptId}.js`;
  try {
    const r = await send('Debugger.getScriptSource', { scriptId: s.scriptId });
    writeFileSync(file, r.scriptSource || '');
    const size = (r.scriptSource || '').length;
    console.log(`[ok] scriptId=${s.scriptId} len=${size} -> ${file}`);
    index.push({ scriptId: s.scriptId, url: s.url, len: size, file });
  } catch (e) {
    console.log(`[fail] scriptId=${s.scriptId} ${e.message}`);
  }
}
writeFileSync(`${OUTDIR}/index.json`, JSON.stringify(index, null, 2));
ws.close();
process.exit(0);
