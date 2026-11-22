(() => {
  const n = globalThis.__netInst;
  if (!n) return 'ERR: no __netInst';
  if (globalThis.__send_hooked) return 'already';
  if (typeof n.send !== 'function') return 'ERR: no send';

  globalThis.__clog = globalThis.__clog || [];
  const CLOG = globalThis.__clog;

  const orig = n.send;
  const wrapper = function (a, b, c, d) {
    try {
      const desc = (v) => {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        const t = typeof v;
        if (t === 'number' || t === 'string' || t === 'boolean') return t + ':' + String(v).slice(0, 60);
        if (t === 'function') return 'fn';
        if (v instanceof Uint8Array || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
          const u8 = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          let hex = '';
          for (let i = 0; i < Math.min(u8.length, 80); i++) hex += u8[i].toString(16).padStart(2, '0');
          return `${v.constructor.name}(len=${u8.length}) ${hex}`;
        }
        if (Array.isArray(v)) return 'Array[' + v.length + ']';
        try { return 'obj{' + Object.keys(v).slice(0, 8).join(',') + '}'; } catch (e) { return 'obj'; }
      };
      CLOG.push({
        ts: Date.now(),
        argc: arguments.length,
        a: desc(a), b: desc(b), c: desc(c), d: desc(d),
        svcNameNow: (() => { try { return String(n._lastServiceName || '').slice(0, 60); } catch (e) { return null; } })(),
      });
      if (CLOG.length > 120) CLOG.shift();
    } catch (e) {
      CLOG.push({ ts: Date.now(), err: String(e && e.message) });
    }
    return orig.apply(this, arguments);
  };

  try { n.send = wrapper; } catch (e) { return 'ERR assign: ' + e.message; }
  globalThis.__send_hooked = true;
  return JSON.stringify({ ok: true, assigned: n.send === wrapper });
})()
