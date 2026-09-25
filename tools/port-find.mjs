// 调试端口自动发现：扫描候选端口，找出真正的 CDP 端点
// 用法:
//   node tools/port-find.mjs              # 扫描并列出所有可用端点
//   node tools/port-find.mjs --json       # 输出 JSON
import { setTimeout as delay } from 'node:timers/promises';

// 常见端口来源：
//   62000       WMPF 生态约定端口（WMPFDebugger / First / WeChatOpenDevTools 默认）
//   62001-62010 多实例时的偏移
//   9421/9420   First 的备用端点
//   9222/9229   Chromium 系（部分工具会复用）
//   9350-9360   微信开发者工具的自动化端口段
const CANDIDATES = [
  62000, 62001, 62002, 62003, 62004, 62005, 62006, 62007, 62008, 62009, 62010,
  9420, 9421, 9222, 9229,
  ...Array.from({ length: 11 }, (_, i) => 9350 + i),
];

// 用 WebSocket 试握手，并用 CDP 的 Runtime.evaluate 验证是不是真端点
async function probeCdp(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let ws;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { ws && ws.close(); } catch { } resolve(r); } };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch (e) { clearTimeout(timer); return done(null); }

    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } })); } catch { }
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.id === 1) {
        clearTimeout(timer);
        done({ port, cdp: true, ok: !m.error, err: m.error ? m.error.message : null });
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); done(null); });
    ws.addEventListener('close', () => { clearTimeout(timer); done(null); });
  });
}

// 判断是否像调试端口（HTTP 返回 426 Upgrade Required = 只接受 WebSocket）
async function looksLikeDebugPort(port, timeoutMs = 900) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.status === 426 || res.status === 200 || res.status === 404;
  } catch { return false; }
}

const jsonMode = process.argv.includes('--json');
const found = [];

for (const port of CANDIDATES) {
  if (!(await looksLikeDebugPort(port))) continue;
  const r = await probeCdp(port);
  if (r && r.cdp) found.push(r);
}

if (jsonMode) {
  console.log(JSON.stringify({ found, scanned: CANDIDATES.length }, null, 2));
} else {
  if (!found.length) {
    console.log('✗ 未发现可用的 CDP 端点。');
    console.log('');
    console.log('  请先启动一个「小程序调试端口暴露工具」，任选其一：');
    console.log('    · WMPFDebugger          https://github.com/evi0s/WMPFDebugger');
    console.log('      (Node 22+，npx ts-node src/index.ts，默认暴露 62000)');
    console.log('    · WeChatOpenDevTools    https://github.com/JaveleyQAQ/WeChatOpenDevTools-Python');
    console.log('    · First (免安装 exe)     D:\\first\\First.exe');
    console.log('');
    console.log('  然后：先启动工具 → 再打开小游戏 → 重跑本脚本');
  } else {
    console.log(`✓ 发现 ${found.length} 个 CDP 端点：`);
    for (const f of found) {
      console.log(`   127.0.0.1:${f.port}  ${f.ok ? '(可用)' : '(握手成功但无响应: ' + f.err + ')'}`);
    }
    const best = found.find(f => f.ok) || found[0];
    console.log('');
    console.log(`推荐使用端口：${best.port}`);
    console.log(`  node tools/tui.mjs --port ${best.port}`);
  }
}
