(() => {
  const d = globalThis.__tdump || [];
  const out = { total: d.length, heartbeats: [], samples: [] };
  function readVarint(arr, p) {
    let v = 0, s = 0, b;
    do { b = arr[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return [v >>> 0, p];
  }
  for (let i = 0; i < d.length; i++) {
    const r = d[i];
    if (!r.before) continue;
    const arr = r.before;
    const asc = arr.map(b => String.fromCharCode(b)).join('');
    // Heartbeat: field1=gid, field2=client_version('1.14.2.x')
    if (asc.indexOf('1.14.') >= 0 && arr[0] === 0x08) {
      const [gid] = readVarint(arr, 1);
      out.heartbeats.push({
        idx: i, gid,
        hex: arr.map(b => b.toString(16).padStart(2, '0')).join(''),
        len: arr.length,
      });
    }
  }
  // 顺带看最后几条的样子
  out.samples = d.slice(-6).map(r => ({
    k: r.k, seq: r.seq, len: r.len,
    hex: r.before ? r.before.slice(0, 40).map(b => b.toString(16).padStart(2, '0')).join('') : null,
  }));
  return JSON.stringify(out, null, 1).slice(0, 3000);
})()
