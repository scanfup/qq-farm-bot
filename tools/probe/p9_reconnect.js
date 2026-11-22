(() => {
  const n = globalThis.__netInst;
  if (!n) return JSON.stringify({ err: 'no __netInst' });
  const S = (f, len) => { try { return String(f).slice(0, len || 900); } catch (e) { return 'ERR'; } };
  const out = {
    _state: n._state,
    _url: n._url,
    _retryCount: n._retryCount,
    _maxRetryCount: n._maxRetryCount,
    clientSeq: n.clientSeq,
    serverSeq: n.serverSeq,
    socketReadyState: (() => { try { return n._socket ? n._socket.readyState : null; } catch (e) { return 'ERR'; } })(),
    connect: S(n.connect, 1200),
    reconnect: S(n.reconnect, 1400),
    retryConnect: S(n.retryConnect, 900),
    onClosed: S(n.onClosed, 900),
    onError: S(n.onError, 700),
    checkNetworkTimeout: S(n.checkNetworkTimeout, 700),
    initSocket: S(n.initSocket, 700),
    onConnected: S(n.onConnected, 700),
  };
  return JSON.stringify(out, null, 1).slice(0, 7000);
})()
