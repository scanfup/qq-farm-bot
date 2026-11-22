(() => {
  const n = globalThis.__netInst;
  if (!n) return 'ERR: no __netInst';
  const H = globalThis;
  H.__t2 = null;

  function hexAll(u8, cap) {
    let s = '';
    for (let i = 0; i < Math.min(u8.length, cap); i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  }
  function ascii(u8, cap) {
    let s = '';
    for (let i = 0; i < Math.min(u8.length, cap); i++) {
      const c = u8[i];
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
    }
    return s;
  }

  try {
    n.send(new Uint8Array(0), 'AllLands', function (r) {
      try {
        const out = { t: Date.now(), hasR: !!r, keys: r ? Object.keys(r) : null };
        if (r && r.meta) {
          out.metaKeys = Object.keys(r.meta);
          out.meta = {};
          for (const k of Object.keys(r.meta)) {
            const v = r.meta[k];
            out.meta[k] = (typeof v === 'string') ? v.slice(0, 80) : (typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v));
          }
        }
        if (r && r.body) {
          const u8 = r.body instanceof ArrayBuffer ? new Uint8Array(r.body)
            : ArrayBuffer.isView(r.body) ? new Uint8Array(r.body.buffer, r.body.byteOffset, r.body.byteLength)
              : null;
          if (u8) {
            out.bodyLen = u8.length;
            out.bodyHex2000 = hexAll(u8, 2000);
            out.bodyAsc = ascii(u8, 300);
            H.__t2_full = Array.from(u8);
          } else {
            out.bodyType = typeof r.body;
            out.bodyStr = String(r.body).slice(0, 300);
          }
        }
        H.__t2 = out;
      } catch (e) { H.__t2 = { err: 'cb: ' + (e && e.message) }; }
    }, 'gamepb.plantpb.PlantService');
    return 'SENT AllLands';
  } catch (e) {
    return 'ERR: ' + (e && e.message);
  }
})()
