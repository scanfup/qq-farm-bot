(() => {
  const n = globalThis.__netInst;
  if (!n) return 'ERR: no __netInst';
  const H = globalThis; 
  H.__testResult = H.__testResult || [];

  // AllLandsRequest {} → 空 body，只读查询，无副作用
  const body = new Uint8Array(0);
  try {
    n.send(body, 'AllLands', function () {
      try {
        const args = Array.prototype.slice.call(arguments).map(function (v) {
          if (v === null) return 'null';
          if (v === undefined) return 'undefined';
          if (typeof v === 'string') return 'str:' + v.slice(0, 120);
          if (typeof v === 'number') return 'num:' + v;
          if (v instanceof Uint8Array || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
            const u8 = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            let hx = '';
            for (let i = 0; i < Math.min(u8.length, 120); i++) hx += u8[i].toString(16).padStart(2, '0');
            return 'bytes(len=' + u8.length + ') ' + hx;
          }
          try { return 'obj{' + Object.keys(v).slice(0, 10).join(',') + '}'; } catch (e) { return 'obj'; }
        });
        H.__testResult.push({ t: Date.now(), argc: arguments.length, args: args });
      } catch (e) { H.__testResult.push({ err: String(e && e.message) }); }
    }, 'gamepb.plantpb.PlantService');
    H.__testResult.push({ t: Date.now(), note: 'sent AllLands, clientSeq now=' + n.clientSeq });
    return 'SENT';
  } catch (e) {
    return 'ERR send: ' + (e && e.message);
  }
})()
