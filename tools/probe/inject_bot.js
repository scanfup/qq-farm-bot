(() => {
  // ===== 注入挂机适配层：__bot =====
  const net = globalThis.__netInst;
  if (!net) return JSON.stringify({ ok: false, err: '__netInst 不存在，请先运行 tools/grab-net.mjs' });

  const toHex = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0'); return s; };
  const fromHex = (h) => { const m = String(h || '').match(/../g) || []; return new Uint8Array(m.map(x => parseInt(x, 16))); };
  const toU8 = (v) => v instanceof ArrayBuffer ? new Uint8Array(v)
    : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;

  globalThis.__bot = {
    net,
    ready() { return !!(this.net || globalThis.__netInst); },

    /** 发请求：bodyHex = 明文 protobuf 的 hex，返回 {ok, meta, bodyHex} */
    call(service, method, bodyHex, timeoutMs) {
      const n = this.net || globalThis.__netInst;
      if (!n) return Promise.resolve({ ok: false, err: 'net not ready' });
      const bytes = bodyHex ? fromHex(bodyHex) : new Uint8Array(0);
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return; done = true;
          resolve({ ok: false, err: 'timeout', method });
        }, timeoutMs || 15000);
        try {
          n.send(bytes, method, function (r) {
            if (done) return; done = true;
            clearTimeout(timer);
            try {
              const b = r && r.body ? toU8(r.body) : null;
              resolve({
                ok: true,
                meta: r && r.meta ? {
                  svc: r.meta.service_name, mth: r.meta.method_name,
                  type: r.meta.message_type, cseq: r.meta.client_seq, sseq: r.meta.server_seq,
                  err: r.meta.error_code || 0,
                  errmsg: r.meta.error_message || '',
                } : null,
                bodyHex: b ? toHex(b) : null,
                bodyLen: b ? b.length : 0,
              });
            } catch (e) { resolve({ ok: false, err: 'decode: ' + e.message }); }
          }, service);
        } catch (e) {
          clearTimeout(timer);
          resolve({ ok: false, err: 'send: ' + (e && e.message) });
        }
      });
    },

    /** 连接/账号状态 */
    status() {
      const n = this.net || globalThis.__netInst;
      if (!n) return null;
      return {
        state: n._state, url: n._url,
        clientSeq: n.clientSeq, serverSeq: n.serverSeq,
        openid: globalThis.tsdk_openid || null,
        gameid: globalThis.tsdk_gameid || null,
      };
    },

    /** 原始发送（不做回调封装，用于对照测试） */
    raw(service, method, bodyHex) {
      const n = this.net || globalThis.__netInst;
      const bytes = bodyHex ? fromHex(bodyHex) : new Uint8Array(0);
      n.send(bytes, method, function () { }, service);
      return true;
    },
  };

  return JSON.stringify({ ok: true, status: globalThis.__bot.status() });
})()
