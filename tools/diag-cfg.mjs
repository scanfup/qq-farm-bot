// 在游戏运行时里寻找配置表（种子/作物名称）
import { Bridge } from './core.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: () => { } });

  const r = await b.evaluate(`(function(){
    var out = { cocos: {}, hits: [] };
    var cc = globalThis.cc;
    if (cc) {
      out.cocos.hasAssetManager = typeof cc.assetManager;
      out.cocos.hasResources = typeof cc.resources;
      out.cocos.hasBundle = cc.assetManager && typeof cc.assetManager.bundles;
      // 列出已加载的 bundle
      try {
        var bundles = cc.assetManager && cc.assetManager.bundles;
        if (bundles) out.cocos.bundles = Object.keys(bundles._map || {}).slice(0, 20);
      } catch(e) { out.cocos.bundleErr = String(e.message); }
      // 找名字里含 config / plant / seed 的全局对象
      for (var k of Object.keys(globalThis)) {
        try {
          var v = globalThis[k];
          if (!v || typeof v !== 'object') continue;
          var n = Object.keys(v);
          if (n.length > 30) out.hits.push({ key: k, size: n.length, sample: n.slice(0, 12) });
        } catch(e) {}
      }
      out.hits = out.hits.slice(0, 15);
    }
    return JSON.stringify(out);
  })()`, { timeoutMs: 15000 });
  console.log('[运行时]', r);

  // 尝试常见的全局配置挂载点
  const probe = await b.evaluate(`(function(){
    var cands = ['gameConfig','GameConfig','config','Config','__gameConfig','PlantConfig','plantConfig','GAME_CONFIG','CFG','DataConfig','dataConfig'];
    var res = {};
    for (var i=0;i<cands.length;i++){
      var c = cands[i];
      try { res[c] = typeof globalThis[c]; } catch(e){ res[c]='err'; }
    }
    return JSON.stringify(res);
  })()`, { timeoutMs: 10000 });
  console.log('[候选挂载点]', probe);

  // 尝试从 cc.resources 里找配置资源
  const res = await b.evaluate(`(function(){
    try {
      var cc = globalThis.cc;
      if (!cc || !cc.assetManager) return 'no-cc';
      var am = cc.assetManager;
      var out = {};
      out.bundles = am.bundles ? Object.keys(am.bundles._map || {}).slice(0,30) : null;
      out.assets = am.assets ? Object.keys(am.assets._map || {}).length : null;
      return JSON.stringify(out);
    } catch(e){ return 'ERR:'+e.message; }
  })()`, { timeoutMs: 10000 });
  console.log('[assetManager]', String(res).slice(0, 800));
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
