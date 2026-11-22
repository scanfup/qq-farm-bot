// 通过 wx 文件系统读取游戏本地的明文配置
import { Bridge } from './core.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: () => { } });

  // 1) 列目录探查
  const probe = await b.evaluate(`(function(){
    var wx = globalThis.wx;
    if (!wx || !wx.getFileSystemManager) return 'no-wx-fs';
    var fs = wx.getFileSystemManager();
    var out = {};
    var dirs = ['', 'gamecaches', 'usr', 'gamecaches/gameConfig', 'gameConfig', 'config', 'usr/gameConfig'];
    for (var i=0;i<dirs.length;i++){
      var d = dirs[i];
      try {
        var r = fs.readdirSync(d);
        out[d || '(root)'] = r.slice(0, 30);
      } catch(e) { out[d || '(root)'] = 'ERR:' + (e.errMsg || e.message).slice(0,60); }
    }
    return JSON.stringify(out);
  })()`, { timeoutMs: 20000 });
  console.log('[文件系统]', String(probe).slice(0, 1800));
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
