(() => {
  const g = globalThis;
  const safe = (fn) => { try { return fn(); } catch (e) { return 'ERR:' + e.message; } };
  const logs = g.tsdk_request_logs;
  const out = {
    len: Array.isArray(logs) ? logs.length : -1,
  };
  if (Array.isArray(logs) && logs.length) {
    out.sample0 = safe(() => JSON.stringify(logs[0]).slice(0, 1500));
    out.sampleLast = safe(() => JSON.stringify(logs[logs.length - 1]).slice(0, 1500));
    out.keysUnion = safe(() => {
      const s = new Set();
      for (const l of logs) if (l && typeof l === 'object') for (const k of Object.keys(l)) s.add(k);
      return [...s];
    });
    // 尝试提取每条的关键字段
    out.rows = safe(() => logs.slice(-25).map(l => {
      if (!l || typeof l !== 'object') return String(l).slice(0, 120);
      const pick = {};
      for (const k of Object.keys(l)) {
        const v = l[k];
        if (v === null || v === undefined) continue;
        if (typeof v === 'string') pick[k] = v.length > 90 ? v.slice(0, 90) + `…(len${v.length})` : v;
        else if (typeof v === 'number' || typeof v === 'boolean') pick[k] = v;
        else if (Array.isArray(v)) pick[k] = '[' + v.length + ']';
        else pick[k] = '{' + Object.keys(v).slice(0, 6).join(',') + '}';
      }
      return pick;
    }));
  }
  return JSON.stringify(out, null, 1);
})()
