// 从 Cocos TextAsset 提取植物/物品配置
import { Bridge } from './core.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: () => { } });

  const r = await b.evaluate(`(function(){
    var cc = globalThis.cc, am = cc.assetManager;
    var map = am.assets && am.assets._map ? am.assets._map : null;
    if (!map) return JSON.stringify({err:'no-map'});
    var out = {};
    for (var uuid in map) {
      try {
        var a = map[uuid];
        if (!a || !a.name) continue;
        if (a.name === 'Plant' || a.name === 'ItemInfo') {
          var t = a.text;
          out[a.name] = { type: typeof t, len: t ? String(t).length : 0, head: t ? String(t).slice(0, 400) : null };
        }
      } catch(e) { out.error = String(e.message); }
    }
    return JSON.stringify(out);
  })()`, { timeoutMs: 30000 });
  console.log(String(r).slice(0, 2500));

  // 若拿到完整文本，落盘分析
  const full = await b.evaluate(`(function(){
    var cc = globalThis.cc, am = cc.assetManager;
    var map = am.assets && am.assets._map ? am.assets._map : null;
    var out = {};
    for (var uuid in map) {
      try {
        var a = map[uuid];
        if (!a || !a.name) continue;
        if ((a.name === 'Plant' || a.name === 'ItemInfo') && a.text) out[a.name] = String(a.text);
      } catch(e) {}
    }
    return JSON.stringify(out);
  })()`, { timeoutMs: 40000 });

  const j = JSON.parse(full);
  mkdirSync('out/cfg', { recursive: true });
  for (const k of Object.keys(j)) {
    writeFileSync(`out/cfg/${k}.json`, j[k]);
    console.log(`\n[保存] out/cfg/${k}.json  ${j[k].length} 字节`);
  }
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
