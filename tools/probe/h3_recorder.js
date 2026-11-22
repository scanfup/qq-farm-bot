(() => {
  // ===== 协议记录器 v2：meta 明文 + body 明文 自动配对 =====
  const t = globalThis.tsdk;
  if (!t) return 'ERR: no tsdk';

  const H = t.HEAPU8;
  const MAXB = 65536;
  globalThis.__plog = globalThis.__plog || [];
  const PLOG = globalThis.__plog;
  const Q = globalThis.__plainq = globalThis.__plainq || [];  // 待配对明文队列
  const meta = globalThis.__plog_meta = { enc: 0, sent: 0, paired: 0, errors: [] };

  // ---------- protobuf 读取 ----------
  function rv(b, p) { let n = 0, s = 0, x; do { x = b[p++]; n += (x & 127) * Math.pow(2, s); s += 7; } while (x & 128); return [n, p]; }
  function utf8(b, s, e) { let o = ''; for (let i = s; i < e; i++) o += String.fromCharCode(b[i]); try { return decodeURIComponent(escape(o)); } catch (_) { return o; } }

  function parseGate(bytes) {
    const out = { meta: null, bodyOff: -1, bodyLen: 0, token: null };
    let p = 0;
    while (p < bytes.length) {
      let tag; [tag, p] = rv(bytes, p);
      const f = tag >> 3, w = tag & 7;
      if (w === 2) {
        let len; [len, p] = rv(bytes, p);
        const s = p, e = p + len;
        if (f === 1) out.meta = parseMeta(bytes.subarray(s, e));
        else if (f === 2) { out.bodyOff = s; out.bodyLen = len; }
        else if (f === 3) out.token = { off: s, len };
        p = e;
      } else if (w === 0) { let v; [v, p] = rv(bytes, p); }
      else if (w === 5) p += 4;
      else if (w === 1) p += 8;
      else break;
    }
    return out;
  }

  function parseMeta(b) {
    const m = { svc: '', mth: '', type: 0, cseq: 0, sseq: 0, err: 0, errmsg: '', metadata: null };
    let p = 0;
    while (p < b.length) {
      let tag; [tag, p] = rv(b, p);
      const f = tag >> 3, w = tag & 7;
      if (w === 2) {
        let len; [len, p] = rv(b, p);
        const s = p, e = p + len;
        if (f === 1) m.svc = utf8(b, s, e);
        else if (f === 2) m.mth = utf8(b, s, e);
        else if (f === 7) m.errmsg = utf8(b, s, e);
        else if (f === 8) m.metadata = utf8(b, s, e).slice(0, 120);
        p = e;
      } else if (w === 0) {
        let v; [v, p] = rv(b, p);
        if (f === 3) m.type = v;
        else if (f === 4) m.cseq = v;
        else if (f === 5) m.sseq = v;
        else if (f === 6) m.err = v;
      } else if (w === 5) p += 4; else if (w === 1) p += 8; else break;
    }
    return m;
  }

  const hex = (a, n) => a.slice(0, n).map(x => x.toString(16).padStart(2, '0')).join('');

  // ---------- hook 1: _encrypt_data ----------
  if (!globalThis.__enc_hooked) {
    const origEnc = t._encrypt_data;
    const wrapEnc = function () {
      try {
        const ptr = arguments[0], len = arguments[1];
        meta.enc++;
        if (typeof ptr === 'number' && ptr > 0 && len > 0 && len <= MAXB && ptr + len <= H.length) {
          Q.push({ len, bytes: Array.from(H.slice(ptr, ptr + len)), ts: Date.now() });
          if (Q.length > 200) Q.shift();
        }
      } catch (e) { meta.errors.push('enc:' + (e && e.message)); }
      return origEnc.apply(this, arguments);
    };
    try { t._encrypt_data = wrapEnc; } catch (e) { meta.errors.push('enc-assign:' + e.message); }
    globalThis.__enc_hooked = true;
  }

  // ---------- hook 2: WebSocket.prototype.send ----------
  if (!globalThis.__ws_hooked) {
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        meta.sent++;
        let bytes = null;
        if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (bytes && bytes.length > 4) {
          const g = parseGate(bytes);
          if (g.meta && (g.meta.svc || g.meta.mth)) {
            // 按长度配对明文 body
            let plain = null, pi = -1;
            for (let i = Q.length - 1; i >= 0; i--) {
              if (Q[i].len === g.bodyLen) { plain = Q[i].bytes; pi = i; break; }
            }
            if (pi >= 0) { Q.splice(pi, 1); meta.paired++; }
            PLOG.push({
              dir: 'SEND',
              ts: Date.now(),
              svc: g.meta.svc, mth: g.meta.mth, type: g.meta.type,
              cseq: g.meta.cseq, sseq: g.meta.sseq,
              frameLen: bytes.length, bodyLen: g.bodyLen,
              token: g.token ? utf8(bytes, g.token.off, g.token.off + g.token.len).slice(0, 40) : null,
              body: plain ? hex(plain, 400) : null,
              plainFound: !!plain,
            });
            if (PLOG.length > 300) PLOG.shift();
          }
        }
      } catch (e) { meta.errors.push('ws:' + (e && e.message)); }
      return origSend.apply(this, arguments);
    };
    globalThis.__ws_hooked = true;
  }

  return JSON.stringify({
    ok: true,
    encHooked: !!globalThis.__enc_hooked,
    wsHooked: !!globalThis.__ws_hooked,
    queued: Q.length,
  });
})()
