// 探测 127.0.0.1:62000 的调试协议类型
const URL = 'ws://127.0.0.1:62000';

function probe() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let ws;
    try {
      ws = new WebSocket(URL);
    } catch (e) {
      return finish({ ok: false, err: 'ctor: ' + e.message });
    }
    const msgs = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      finish({ ok: true, note: 'timeout-no-close', msgs });
    }, 6000);

    ws.addEventListener('open', () => {
      msgs.push('[open] connected');
      // 试探 CDP 基础命令
      const cmds = [
        { id: 1, method: 'Runtime.enable' },
        { id: 2, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } },
        { id: 3, method: 'Schema.getDomains' },
      ];
      for (const c of cmds) { try { ws.send(JSON.stringify(c)); } catch (e) { msgs.push('[send-err] ' + c.method + ' ' + e.message); } }
    });
    ws.addEventListener('message', (ev) => {
      const d = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      msgs.push('[msg] ' + d.slice(0, 600));
    });
    ws.addEventListener('error', (ev) => {
      msgs.push('[error] ' + (ev.message || ev.error || 'unknown'));
      clearTimeout(timer);
      finish({ ok: false, err: 'ws error', msgs });
    });
    ws.addEventListener('close', (ev) => {
      msgs.push('[close] code=' + ev.code + ' reason=' + ev.reason);
      clearTimeout(timer);
      finish({ ok: true, msgs });
    });
  });
}

const r = await probe();
console.log(JSON.stringify(r, null, 2));
