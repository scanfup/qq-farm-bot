(() => {
  const L = globalThis.__plog || [];
  const clean = L.map(r => ({
    svc: r.svc, mth: r.mth, type: r.type,
    cseq: r.cseq, sseq: r.sseq,
    frameLen: r.frameLen, bodyLen: r.bodyLen,
    tokenLen: r.token ? r.token.length : 0,
    plainFound: r.plainFound,
    bodyHex: r.body,
    bodyAsc: (() => {
      if (!r.body) return null;
      let s = '';
      for (let i = 0; i < r.body.length; i += 2) {
        const c = parseInt(r.body.substr(i, 2), 16);
        s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
      return s.slice(0, 160);
    })(),
  }));
  return JSON.stringify({ total: clean.length, rows: clean }, null, 1);
})()
