// 验证修正后的 detectGid（严格匹配心跳结构）
import { Bridge } from './core.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
const t0 = Date.now();
try {
  await b.ensure({ onLog: (m) => console.log('[log]', m) });
  console.log('[ctx]', b.ctxId);

  // 查看页面内 hook 的标记状态
  const mark = await b.evaluate(
    'String(!!(globalThis.tsdk && globalThis.tsdk._encrypt_data && globalThis.tsdk._encrypt_data.__isGidHook))',
    { timeoutMs: 8000 },
  );
  console.log('[hook 已标记]', mark);

  const gid = await b.detectGid({ onLog: (m) => console.log('[gid]', m), waitMs: 45000 });
  console.log(`\n[结果] gid = ${gid}   用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 再查一次标记，确认新 hook 已装
  const mark2 = await b.evaluate(
    'String(!!(globalThis.tsdk && globalThis.tsdk._encrypt_data && globalThis.tsdk._encrypt_data.__isGidHook))',
    { timeoutMs: 8000 },
  );
  console.log('[hook 标记(安装后)]', mark2);

  const list = await b.evaluate('JSON.stringify(globalThis.__gids || [])', { timeoutMs: 8000 });
  console.log('[捕获列表]', list);
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
