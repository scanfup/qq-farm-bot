(() => {
  const t = globalThis.tsdk;
  if (!t) return 'ERR: no tsdk';
  if (globalThis.__tdump_hooked) return 'already hooked';

  const H = t.HEAPU8;
  const MAX = 8192;
  const CAP = 400;

  const dump = globalThis.__tdump = globalThis.__tdump || [];
  const meta = globalThis.__tdump_meta = { enc: 0, dec: 0, errors: [] };

  function read(ptr, len) {
    try {
      if (typeof ptr !== 'number' || ptr <= 0) return null;
      const n = Math.min(Number(len) || 0, MAX);
      if (n <= 0) return null;
      if (ptr + n > H.length) return null;
      return Array.from(H.slice(ptr, ptr + n));
    } catch (e) { return null; }
  }

  function hook(name, kind) {
    const orig = t[name];
    if (typeof orig !== 'function') { meta.errors.push('missing ' + name); return; }
    const wrapper = function () {
      try {
        const argv = Array.prototype.slice.call(arguments);
        const ptr = argv[0], len = argv[1];
        meta[kind]++;
        const before = read(ptr, len);
        const r = orig.apply(this, argv);
        const after = read(ptr, len);
        const st = (new Error().stack || '');
        dump.push({
          k: kind,
          seq: meta[kind],
          ptr, len,
          ret: (typeof r === 'number' ? r : String(r)),
          before, after,
          stack: st.split('\n').slice(1, 7).map(s => s.trim().slice(0, 140)),
        });
        if (dump.length > CAP) dump.shift();
        return r;
      } catch (e) {
        meta.errors.push(kind + ': ' + (e && e.message));
        return orig.apply(this, arguments);
      }
    };
    try {
      t[name] = wrapper;
      if (t[name] !== wrapper) meta.errors.push('assign-not-taken ' + name);
    } catch (e) {
      try { Object.defineProperty(t, name, { value: wrapper, writable: true, configurable: true }); }
      catch (e2) { meta.errors.push('defineProperty-failed ' + name + ': ' + e2.message); }
    }
  }

  hook('_encrypt_data', 'enc');
  hook('_decrypt_data', 'dec');
  globalThis.__tdump_hooked = true;
  return JSON.stringify({ ok: true, enc: typeof t._encrypt_data, dec: typeof t._decrypt_data });
})()
