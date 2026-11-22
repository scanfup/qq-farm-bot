(() => {
  const g = globalThis;
  const safe = (fn, d) => { try { return fn(); } catch (e) { return 'ERR:' + e.message; } };
  const t = g.tsdk;
  const out = {
    tsdk_type: typeof t,
    tsdk_isNull: t === null,
    tsdk_keys: safe(() => t ? Object.keys(t) : null),
    tsdk_ownProps: safe(() => t ? Object.getOwnPropertyNames(t) : null),
    tsdk_proto: safe(() => t ? Object.getOwnPropertyNames(Object.getPrototypeOf(t) || {}) : null),
    globals: {
      tsdk_gameid: safe(() => String(g.tsdk_gameid)),
      tsdk_appkey: safe(() => String(g.tsdk_appkey)),
      tsdk_account_type: safe(() => String(g.tsdk_account_type)),
      tsdk_openid: safe(() => String(g.tsdk_openid)),
      tsdk_init_callback: safe(() => typeof g.tsdk_init_callback),
      tsdk_request_logs: safe(() => Array.isArray(g.tsdk_request_logs) ? 'array len=' + g.tsdk_request_logs.length : typeof g.tsdk_request_logs),
      tsdk_server_ts_gen: safe(() => String(g.__tsdk_server_timestamp_request_generations)),
      ACEVM: safe(() => typeof g.ACEVM),
      AegisReport: safe(() => typeof g.AegisReport),
    },
    aceVars: safe(() => Object.keys(g).filter(k => k.indexOf('Ace') >= 0 || k.indexOf('ce_') >= 0).map(k => k + '=' + (typeof g[k]))),
  };
  return JSON.stringify(out, null, 1);
})()
