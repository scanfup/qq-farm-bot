(() => {
  const g = globalThis;
  const cc = g.cc;
  const safe = (fn, d) => { try { return fn(); } catch (e) { return d; } };
  const out = {};

  const scene = cc.director.getScene();
  const persist = scene.getChildByName('OopsFrameworkPersistNode');
  out.persistFound = !!persist;

  function compsOf(node) {
    const arr = [];
    const list = node._components || [];
    for (const c of list) {
      let n = safe(() => c.constructor.name, '?');
      let cls = safe(() => (c.__classname__ || c.constructor.__classname__ || ''), '');
      arr.push({ name: n, class: cls });
    }
    return arr;
  }

  if (persist) {
    out.persistComps = compsOf(persist);
    out.persistChildren = safe(() => persist.children.map(c => ({ name: c.name, comps: compsOf(c) })), []);
    out.persistProps = safe(() => Object.keys(persist).filter(k => !k.startsWith('_')).slice(0, 40), []);
  }

  // 全场景递归找所有组件类名（含 net/socket 类）
  out.allComps = safe(() => {
    const seen = new Set();
    const walk = (node, d) => {
      for (const c of (node._components || [])) {
        const n = c.constructor && c.constructor.name || '?';
        seen.add(n);
      }
      if (d < 6) for (const ch of node.children) walk(ch, d + 1);
    };
    walk(scene, 0);
    return [...seen].slice(0, 60);
  }, []);

  // 尝试在 cc 命名空间下找网络/框架类
  out.ccNet = safe(() => Object.keys(cc).filter(k => /net|socket|oops|framework|msg|proto/i.test(k)), []);

  // 全局搜 Oops
  out.oopsGlobals = safe(() => Object.keys(g).filter(k => /oops|Oops|OOPS/i.test(k)), []);

  // cc 上是否有 director 的场景栈（可见多场景）
  out.sceneName = safe(() => scene.name, null);
  out.sceneChildren = safe(() => scene.children.map(c => c.name), []);

  return JSON.stringify(out, null, 1);
})()
