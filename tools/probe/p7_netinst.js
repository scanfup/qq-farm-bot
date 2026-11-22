(() => {
  const n = globalThis.__netInst;
  if (!n) return JSON.stringify({ err: 'no __netInst' });
  const safe = (fn, d) => { try { return fn(); } catch (e) { return d; } };
  const S = (f, len) => { try { return String(f).slice(0, len || 900); } catch (e) { return 'ERR'; } };
  const out = {
    ctor: safe(() => n.constructor.name, '?'),
    state: safe(() => n._state, null),
    url: safe(() => String(n._url), null),
    clientSeq: safe(() => n.clientSeq, null),
    serverSeq: safe(() => n.serverSeq, null),
    lastEncryptScheme: safe(() => JSON.stringify(n._lastEncryptScheme), null),
    serviceMapKeys: safe(() => Object.keys(n._serviceInstaceMap || {}), []),
    serviceMapSample: safe(() => {
      const m = n._serviceInstaceMap || {};
      const o = {};
      for (const k of Object.keys(m).slice(0, 10)) {
        const s = m[k];
        o[k] = { ctor: s && s.constructor && s.constructor.name, methods: s ? Object.getOwnPropertyNames(Object.getPrototypeOf(s) || {}).slice(0, 25) : null };
      }
      return o;
    }, null),
    // 关键：函数源码
    getServiceFunName: S(n.getServiceFunName, 1200),
    getService: S(n.getService, 1500),
    send_src: S(n.send, 2200),
  };
  return JSON.stringify(out, null, 1);
})()
