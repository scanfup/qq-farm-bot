// TUI 冒烟测试：不进入交互主循环，只验证渲染 + 数据 + 自愈
import { Tui } from './tui.mjs';
import { Bridge } from './core.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
const t = new Tui(b, { gid: Number(process.env.MY_GID || 0) || null, seedId: 20002 });

// 捕获渲染输出而不是打到终端
let rendered = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => { rendered += String(s); return true; };

const log = (m) => console.log('[log]', m);
try {
  await b.ensure({ onLog: log });
  t.log(`桥接就绪 ctx=${b.ctxId}`, 'ok');
  if (!t.gid) t.gid = await b.detectGid({ onLog: log, waitMs: 32000 });
  t.log('gid = ' + t.gid, 'ok');

  t.conn = (await b.ping()).status;
  await t.refresh();
  t.log(`加载完成：土地 ${t.lands.length} 好友 ${t.friends.length}`, 'ok');

  // 渲染一帧
  rendered = '';
  t.render();
  process.stdout.write = origWrite;

  const lines = rendered.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n');
  console.log('\n=== 渲染帧 ===');
  for (const l of lines.slice(0, 26)) console.log('│ ' + l.replace(/\s+$/, ''));

  console.log('\n=== 断言 ===');
  const checks = [
    ['包含账号名', /林林林|shilin|白萝卜|成熟|空地/.test(rendered)],
    ['土地已加载', t.lands.length > 0],
    ['好友已加载', t.friends.length > 0],
    ['gid 已解析', Number(t.gid) > 0],
    ['渲染有顶栏', rendered.includes('QQ 农场挂机')],
  ];
  let pass = 0;
  for (const [name, okv] of checks) { console.log(`  ${okv ? '✓' : '✗'} ${name}`); if (okv) pass++; }
  console.log(`\n${pass}/${checks.length} 通过`);
} catch (e) {
  process.stdout.write = origWrite;
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 150);
}
