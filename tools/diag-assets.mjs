// 遍历 Cocos 已加载资源，定位配置表并尝试提取种子名称
import { Bridge } from './core.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: () => { } });

  // 1) 列出疑似配置的资源
  const list = await b.evaluate(`(function(){
    var cc = globalThis.cc, am = cc.assetManager;
    var map = am.assets && am.assets._map ? am.assets._map : null;
    if (!map) return 'no-map';
    var out = [];
    for (var uuid in map) {
      try {
        var a = map[uuid];
        if (!a || !a.name) continue;
        var nm = String(a.name);
        if (/config|cfg|plant|seed|item|goods|data/i.test(nm)) {
          var isJson = !!(a.json);
          var keys = isJson ? Object.keys(a.json).slice(0, 8) : [];
          out.push({ name: nm, uuid: String(uuid).slice(0, 8), ctor: a.constructor && a.constructor.name, isJson: isJson, jsonKeys: keys });
        }
      } catch(e) {}
    }
    return JSON.stringify({ total: Object.keys(map).length, hits: out.slice(0, 40) });
  })()`, { timeoutMs: 30000 });
  console.log('[资源扫描]', String(list).slice(0, 2500));
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
