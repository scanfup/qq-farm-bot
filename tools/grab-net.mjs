// 用断点 + callFrames[].this 抓取游戏网络层实例
// 用法: node tools/grab-net.mjs [line0] [col]
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 62000;
const TARGET_URL = process.argv[2] || 'https://usr/subpackages/main/game.js';
const LINE0 = Number(process.argv[3] || 2);          // 0-based
const COL = Number(process.argv[4] || 2842155);
const WAIT_S = Number(process.argv[5] || 40);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let id = 0;
const pending = new Map();
const scripts = [];

function send(method, params) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
  });
}

let pausedInfo = null;
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Debugger.scriptParsed') scripts.push(m.params);
  if (m.method === 'Debugger.paused' && !pausedInfo) pausedInfo = m.params;
});
ws.addEventListener('error', (e) => console.log('[ws-error]', e.message || 'unknown'));

await new Promise(r => ws.addEventListener('open', r));
await send('Debugger.enable');
await new Promise(r => setTimeout(r, 1500));

let script = scripts.find(s => (s.url || '') === TARGET_URL) || scripts.find(s => (s.url || '').includes('subpackages/main/game.js'));
if (!script) { console.log('[ERR] script not found'); process.exit(1); }
console.log(`[script] id=${script.scriptId} url=${script.url}`);

const bp = await send('Debugger.setBreakpoint', {
  location: { scriptId: script.scriptId, lineNumber: LINE0, columnNumber: COL },
});
console.log('[bp] requested ->', JSON.stringify(bp.actualLocation));

console.log(`[wait] 等待断点命中 (最多 ${WAIT_S}s, 心跳 25s 一发) ...`);
for (let i = 0; i < WAIT_S * 2 && !pausedInfo; i++) await new Promise(r => setTimeout(r, 500));

if (!pausedInfo) {
  console.log('[FAIL] 断点未命中');
  await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId });
  ws.close(); process.exit(0);
}

console.log('[HIT] reason =', pausedInfo.reason);
const frames = pausedInfo.callFrames || [];
console.log('[frames]', frames.length);

const report = [];
for (let i = 0; i < Math.min(frames.length, 10); i++) {
  const f = frames[i];
  let thisDesc = null;
  try {
    thisDesc = {
      type: f.this && f.this.type,
      subtype: f.this && f.this.subtype,
      className: f.this && f.this.className,
      description: (f.this && f.this.description || '').slice(0, 200),
      objectId: f.this && f.this.objectId ? 'yes' : null,
    };
  } catch (e) { }
  report.push({
    i,
    fn: f.functionName,
    loc: f.location,
    this: thisDesc,
  });
  console.log(`  #${i} fn=${f.functionName || '(anon)'} line=${f.location.lineNumber} col=${f.location.columnNumber} this=${thisDesc ? thisDesc.className || thisDesc.type : 'none'} objId=${thisDesc && thisDesc.objectId ? 'YES' : 'no'}`);
}

// 找到带 objectId 的 this，把它的方法列出来并存入全局
mkdirSync('out/net', { recursive: true });
let grabbed = null;
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  if (!f.this || !f.this.objectId) continue;
  if (f.this.type !== 'object') continue;
  try {
    const r = await send('Runtime.callFunctionOn', {
      objectId: f.this.objectId,
      functionDeclaration: `function(){
        try {
          const self = this;
          const methods = [];
          let o = self, d = 0;
          while (o && d < 4) {
            for (const k of Object.getOwnPropertyNames(o)) {
              try { if (typeof self[k] === 'function' && methods.indexOf(k) < 0) methods.push(k); } catch(e){}
            }
            o = Object.getPrototypeOf(o); d++;
          }
          const own = Object.keys(self).slice(0, 40);
          globalThis.__netInst = self;
          globalThis.__netMethods = methods;
          globalThis.__netOwnKeys = own;
          globalThis.__netCtor = self.constructor ? self.constructor.name : '?';
          return JSON.stringify({ ctor: globalThis.__netCtor, methodCount: methods.length, methods: methods.slice(0,80), ownKeys: own });
        } catch(e) { return 'ERR:' + e.message; }
      }`,
      returnByValue: true,
    });
    if (r && r.result && r.result.value && r.result.value.indexOf('ERR') !== 0) {
      grabbed = { frameIndex: i, fn: f.functionName, data: r.result.value };
      break;
    }
  } catch (e) { console.log(`  [grab#${i}] ${e.message}`); }
}

await send('Debugger.resume');
await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId }).catch(() => { });
console.log('[resumed]');

if (grabbed) {
  console.log('\n=== GRABBED ===');
  console.log(JSON.stringify(grabbed, null, 1).slice(0, 4000));
  writeFileSync('out/net/grabbed.json', JSON.stringify({ report, grabbed }, null, 2));
} else {
  console.log('\n[!] 未取到带 objectId 的 this');
  writeFileSync('out/net/grabbed.json', JSON.stringify({ report, grabbed: null }, null, 2));
}
ws.close();
process.exit(0);
