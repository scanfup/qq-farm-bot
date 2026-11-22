(() => {
  const g = globalThis;
  const keys = Object.keys(g);
  const t = (n) => { try { return typeof g[n]; } catch (e) { return 'ERR'; } };
  const out = {
    keyCount: keys.length,
    types: {
      wx: t('wx'),
      GameGlobal: t('GameGlobal'),
      cc: t('cc'),
      WebSocket: t('WebSocket'),
      window: t('window'),
      global: t('global'),
      App: t('App'),
    },
    keysHead: keys.slice(0, 300),
  };
  return JSON.stringify(out, null, 1);
})()
