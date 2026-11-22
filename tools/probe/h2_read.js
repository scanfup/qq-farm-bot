(() => {
  const d = globalThis.__tdump || [];
  const hex = (arr, n) => arr ? arr.slice(0, n).map(b => b.toString(16).padStart(2, '0')).join('') : null;
  const asc = (arr, n) => arr ? arr.slice(0, n).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('') : null;
  const rows = d.slice(-24).map(r => ({
    k: r.k, seq: r.seq, ptr: r.ptr, len: r.len, ret: r.ret,
    beforeLen: r.before ? r.before.length : null,
    beforeHex: hex(r.before, 160),
    beforeAsc: asc(r.before, 120),
    afterLen: r.after ? r.after.length : null,
    afterHex: hex(r.after, 48),
    stack: r.stack ? r.stack.slice(0, 4) : null,
  }));
  return JSON.stringify({ total: d.length, rows }, null, 1);
})()
