(() => {
  const g = globalThis;
  const safe = (fn, d) => { try { return fn(); } catch (e) { return d; } };
  const out = { sendHolders: [], candidates: [], cocos: {} };

  // 1. 找带 send 方法的全局对象
  for (const k of Object.keys(g)) {
    try {
      const o = g[k];
      if (!o || (typeof o !== 'object' && typeof o !== 'function')) continue;
      const hasSend = typeof o.send === 'function';
      const hasEnc = typeof o.encryptData === 'function';
      if (hasSend || hasEnc) {
        out.sendHolders.push({
          key: k,
          ctor: safe(() => o.constructor && o.constructor.name, '?'),
          hasSend, hasEnc,
          keys: safe(() => Object.keys(o).slice(0, 12), []),
        });
      }
    } catch (e) { }
  }

  // 2. Cocos 场景信息
  const cc = g.cc;
  if (cc) {
    out.cocos.hasDirector = typeof cc.director;
    out.cocos.scene = safe(() => cc.director && cc.director.getScene() ? cc.director.getScene().name : null, null);
    out.cocos.hasGame = typeof cc.game;
    out.cocos.winSize = safe(() => cc.view ? cc.view.getVisibleSize() : null, null);
    // 遍历场景节点，找带网络相关组件的
    out.cocos.nodeCount = safe(() => {
      let n = 0;
      const walk = (node, d) => { n++; if (d > 2) return; for (const c of node.children) walk(c, d + 1); };
      const s = cc.director.getScene();
      if (s) walk(s, 0);
      return n;
    }, -1);
    out.cocos.topNodes = safe(() => {
      const s = cc.director.getScene();
      return s ? s.children.map(c => c.name).slice(0, 30) : [];
    }, []);
  } else {
    out.cocos = 'no cc';
  }

  // 3. 找 window 上可能的网络管理器（名字含 net/socket/gate/conn）
  out.nameHits = safe(() => Object.keys(g).filter(k => /net|sock|gate|conn|socket|proto|pb|msg/i.test(k)).slice(0, 40), []);

  return JSON.stringify(out, null, 1);
})()
