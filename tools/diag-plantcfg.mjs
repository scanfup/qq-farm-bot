// 探索 Plant / ItemInfo 配置资源结构，提取种子名称与价格
import { Bridge } from './core.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: () => { } });

  const r = await b.evaluate(`(function(){
    var cc = globalThis.cc, am = cc.assetManager;
    var map = am.assets && am.assets._map ? am.assets._map : null;
    if (!map) return 'no-map';
    var want = { Plant: null, ItemInfo: null };
    for (var uuid in map) {
      try {
        var a = map[uuid];
        if (!a || !a.name) continue;
        if (a.name === 'Plant' && !want.Plant) want.Plant = a;
        if (a.name === 'ItemInfo' && !want.ItemInfo) want.ItemInfo = a;
      } catch(e) {}
    }
    var out = {};
    function describe(name, a) {
      if (!a) { out[name] = 'not-found'; return; }
      var d = { ctor: a.constructor && a.constructor.name, own: Object.keys(a).slice(0, 25) };
      // 尝试常见的数据容器
      for (var k of ['json','data','_data','config','_config','map','_map','list','_list','rawData']) {
        try {
          var v = a[k];
          if (v === undefined || v === null) continue;
          if (Array.isArray(v)) d['arr:'+k] = { len: v.length, first: v[0] ? Object.keys(v[0]).slice(0,15) : null };
          else if (typeof v === 'object') d['obj:'+k] = { keys: Object.keys(v).slice(0,15), len: Object.keys(v).length };
          else d['val:'+k] = typeof v;
        } catch(e) { d['err:'+k] = String(e.message); }
      }
      out[name] = d;
    }
    describe('Plant', want.Plant);
    describe('ItemInfo', want.ItemInfo);
    return JSON.stringify(out) ;
  })()`, { timeoutMs: 30000 });
  console.log(String(r).slice(0, 3000));
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
