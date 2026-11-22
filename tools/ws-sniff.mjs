// 截取 WebSocket 帧：CDP Network domain
// 用法: node tools/ws-sniff.mjs [秒数]
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 62000;
const SECONDS = Number(process.argv[2] || 40);
const OUTDIR = 'out/ws';
mkdirSync(OUTDIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const JSONL = `${OUTDIR}/frames_${STAMP}.jsonl`;
writeFileSync(JSONL, '');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let id = 0;
const pending = new Map();

function send(method, params) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 12000);
  });
}

const stats = { created: 0, sent: 0, recv: 0, closed: 0, lastErr: null };

function hexOf(b64) {
  return Buffer.from(b64, 'base64').toString('hex');
}
function preview(b64, n = 64) {
  const buf = Buffer.from(b64, 'base64');
  return {
    len: buf.length,
    hex: buf.subarray(0, n).toString('hex'),
    ascii: buf.subarray(0, n).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
  };
}

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  const p = m.params || {};
  if (m.method === 'Network.webSocketCreated') {
    stats.created++;
    console.log(`\n[WS-CREATED] id=${p.requestId} url=${p.url}`);
    appendFileSync(JSONL, JSON.stringify({ t: Date.now(), ev: 'created', ...p }) + '\n');
  } else if (m.method === 'Network.webSocketWillSendHandshakeRequest') {
    console.log(`[WS-HANDSHAKE] ${JSON.stringify(p.request?.headers || {}).slice(0, 400)}`);
    appendFileSync(JSONL, JSON.stringify({ t: Date.now(), ev: 'handshake', ...p }) + '\n');
  } else if (m.method === 'Network.webSocketFrameSent' || m.method === 'Network.webSocketFrameReceived') {
    const dir = m.method.endsWith('Sent') ? 'SEND' : 'RECV';
    const pd = p.response?.payloadData || '';
    const pv = preview(pd);
    stats[dir === 'SEND' ? 'sent' : 'recv']++;
    console.log(`[${dir}] rid=${p.requestId} len=${pv.len} hex=${pv.hex}`);
    console.log(`        ascii: ${pv.ascii}`);
    appendFileSync(JSONL, JSON.stringify({ t: Date.now(), ev: 'frame', dir, requestId: p.requestId, opcode: p.response?.opcode, len: pv.len, payloadData: pd }) + '\n');
  } else if (m.method === 'Network.webSocketClosed') {
    stats.closed++;
    console.log(`[WS-CLOSED] rid=${p.requestId}`);
    appendFileSync(JSONL, JSON.stringify({ t: Date.now(), ev: 'closed', ...p }) + '\n');
  } else if (m.method === 'Network.webSocketFrameError') {
    stats.lastErr = p.errorMessage;
    console.log(`[WS-FRAME-ERROR] ${p.errorMessage}`);
  }
});
ws.addEventListener('error', (e) => { console.log('[ws-error]', e.message || 'unknown'); });

await new Promise(r => ws.addEventListener('open', r));

try { await send('Network.enable', { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 50_000_000 }); console.log('[ok] Network.enable'); }
catch (e) { console.log('[fail] Network.enable:', e.message); }

try { await send('Page.enable'); console.log('[ok] Page.enable'); } catch (e) { console.log('[warn] Page.enable:', e.message); }
try { await send('Runtime.enable'); console.log('[ok] Runtime.enable'); } catch { }

console.log(`\n[sniff] 监听 ${SECONDS}s ... (心跳 25s 一发)\n`);
await new Promise(r => setTimeout(r, SECONDS * 1000));

console.log('\n=== stats ===');
console.log(JSON.stringify(stats, null, 1));
console.log('jsonl ->', JSONL);
ws.close();
process.exit(0);
