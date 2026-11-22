// 在压缩源码中按 key 或偏移提取上下文
// 用法:
//   node tools/extract.mjs <file> --key encryptData [--key serviceName] [--ctx 300]
//   node tools/extract.mjs <file> --at 4557523 [--at 2842155] [--ctx 400]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const argv = process.argv.slice(3);
function argOf(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : def;
}
const CTX = Number(argOf('--ctx', 300));
const keys = [];
const ats = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--key') keys.push(argv[i + 1]);
  if (argv[i] === '--at') ats.push(Number(argv[i + 1]));
}

const src = readFileSync(file, 'utf8');
const lines = src.split('\n');
console.log(`[file] ${file}  chars=${src.length}  lines=${lines.length}`);
console.log(`[lines] ${lines.slice(0, 8).map((l, i) => i + 1 + ':' + l.length).join('  ')}`);

// 构建 行首全局偏移
const lineStart = [];
let acc = 0;
for (const l of lines) { lineStart.push(acc); acc += l.length + 1; }

function locate(globalOff) {
  let lo = 0, hi = lineStart.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStart[mid] <= globalOff) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return { line: ans + 1, col: globalOff - lineStart[ans] };
}
function atOffset(globalOff, ctx) {
  const s = Math.max(0, globalOff - ctx);
  const e = Math.min(src.length, globalOff + ctx);
  return { ...locate(globalOff), text: src.slice(s, e) };
}

for (const at of ats) {
  console.log(`\n${'='.repeat(70)}\n[AT] offset=${at}`);
  const r = atOffset(at, CTX);
  console.log(`     line=${r.line} col=${r.col}`);
  console.log(r.text.replace(/\s+/g, ' ').slice(0, CTX * 2 + 80));
}

for (const k of keys) {
  console.log(`\n${'='.repeat(70)}\n[KEY] "${k}"`);
  let from = 0, n = 0;
  while (n < 8) {
    const i = src.indexOf(k, from);
    if (i < 0) break;
    const r = atOffset(i, CTX);
    console.log(`\n  --- hit#${++n} @${i} line=${r.line} col=${r.col} ---`);
    console.log('  ' + r.text.replace(/\s+/g, ' ').slice(0, CTX * 2 + 60));
    from = i + k.length;
  }
  if (!n) console.log('  (none)');
}
