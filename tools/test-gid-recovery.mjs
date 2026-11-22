// 模拟「hook 残留但已失效」场景，验证 detectGid 能否自愈
import { Bridge } from './core.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: (m) => console.log('[log]', m) });
  console.log('[ctx]', b.ctxId);

  // 1) 制造故障现场：设置 __gidhook 标记，但把 _encrypt_data 换回原始函数
  const sabotage = await b.evaluate(`(function(){
    var t=globalThis.tsdk; if(!t) return 'notsdk';
    // 保存当前包装作为"原始"，再把标记打上、但让当前函数不带 __isGidHook
    globalThis.__gidhook = 1;
    globalThis.__gids = [999999];
    var cur = t._encrypt_data;
    // 用一层无标记的包装冒充"被覆盖的函数"
    var plain = function(){ return cur.apply(this, arguments); };
    t._encrypt_data = plain;    // 现在：有 __gidhook，但 _encrypt_data 无 __isGidHook 标记
    return JSON.stringify({
      标记: !!globalThis.__gidhook,
      函数带isGidHook: !!t._encrypt_data.__isGidHook,
      残留gids: globalThis.__gids
    });
  })()`, { timeoutMs: 10000 });
  console.log('[故障现场]', sabotage);

  // 2) 用新代码跑 detectGid，应当检测到无标记 → 重新包装 → 清空残留 → 抓到真心跳
  const t0 = Date.now();
  const gid = await b.detectGid({ onLog: (m) => console.log('[gid]', m), waitMs: 50000 });
  console.log(`\n[结果] gid = ${gid}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const after = await b.evaluate(`JSON.stringify({
    函数带isGidHook: !!(globalThis.tsdk._encrypt_data.__isGidHook),
    gids: globalThis.__gids
  })`, { timeoutMs: 8000 });
  console.log('[修复后]', after);
  console.log(gid === 1214573954 ? '\n✓ 自愈成功，且未误用残留值 999999' : '\n✗ 结果异常');
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
