(() => {
  // ===== 通过 CallSite.getThis() 钓出游戏网络层实例 =====
  if (globalThis.__net_hooked) {
    return JSON.stringify({ ok: true, already: true, got: !!globalThis.__netInst });
  }
  const g = globalThis;
  g.__netInst = null;
  g.__netProbe = { tried: 0, frames: [], err: null };

  function captureThis() {
    const orig = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = function (err, stack) { return stack; };
      const e = new Error();
      const frames = e.stack;           // CallSite[]
      const res = [];
      for (const f of frames) {
        let file = '', fn = '', self = null;
        try { file = f.getFileName() || ''; } catch (x) { }
        try { fn = f.getFunctionName() || ''; } catch (x) { }
        try { self = f.getThis(); } catch (x) { }
        res.push({ fn, file: file.slice(-46), selfType: self === null ? 'null' : typeof self });
        if (self && typeof self === 'object' && /game\.js/.test(file)) {
          let hasSend = false, hasEnc = false, hasDec = false;
          try { hasSend = typeof self.send === 'function'; } catch (x) { }
          try { hasEnc = typeof self.encryptData === 'function'; } catch (x) { }
          try { hasDec = typeof self.decryptData === 'function'; } catch (x) { }
          if (hasSend || hasEnc || hasDec) {
            return { self, info: { fn, file: file.slice(-46), hasSend, hasEnc, hasDec } };
          }
        }
      }
      return { self: null, info: { frames: res.slice(0, 12) } };
    } catch (x) {
      return { self: null, info: { err: String(x && x.message) } };
    } finally {
      Error.prepareStackTrace = orig;
    }
  }

  const proto = WebSocket.prototype;
  const origSend = proto.send;
  proto.send = function (data) {
    try {
      g.__netProbe.tried++;
      if (!g.__netInst) {
        const r = captureThis();
        if (r.self) {
          g.__netInst = r.self;
          g.__netProbe.frames = [r.info];
          // 记录实例上的方法名，便于后续调用
          try {
            const keys = [];
            let o = r.self, depth = 0;
            while (o && depth < 4) {
              for (const k of Object.getOwnPropertyNames(o)) {
                if (typeof r.self[k] === 'function' && keys.indexOf(k) < 0) keys.push(k);
              }
              o = Object.getPrototypeOf(o); depth++;
            }
            g.__netMethods = keys.slice(0, 120);
          } catch (x) { }
        } else if (r.info && r.info.frames && g.__netProbe.frames.length < 3) {
          g.__netProbe.frames.push(r.info.frames);
        }
      }
    } catch (x) {
      g.__netProbe.err = String(x && x.message);
    }
    return origSend.apply(this, arguments);
  };

  g.__net_hooked = true;
  return JSON.stringify({ ok: true, hooked: true });
})()
