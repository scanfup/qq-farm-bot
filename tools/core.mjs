// 核心桥接层：CDP 连接 + 上下文探测 + __netInst 抓取 + __bot 注入 + 自愈
// 供 TUI 与命令行工具复用
import { readFileSync } from 'node:fs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Bridge {
  constructor(opts = {}) {
    this.port = Number(opts.port || process.env.CDP_PORT || 62000);
    this.ctxId = opts.ctxId || null;
    this.gid = Number(opts.gid || 0) || null;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this.scripts = [];
    this.contexts = [];
    this.lastError = null;
    this.status = 'idle';       // idle | connecting | ready | error
    this.recoveries = 0;
  }

  get url() { return `ws://127.0.0.1:${this.port}`; }

  // ---------- 底层 ----------
  async _dial(timeoutMs = 10000) {
    if (this.ws && this.ws.readyState === 1) return;
    try {
      await this._dialPort(this.port, timeoutMs);
      return;
    } catch (e) {
      // 默认端口不通时自动扫描其他常见端口（不同工具可能暴露在不同端口）
      const alt = await this._autoFindPort();
      if (alt && alt !== this.port) {
        this.port = alt;
        this.lastError = `原端口不可用，已自动切换到 ${alt}`;
        await this._dialPort(alt, timeoutMs);
        return;
      }
      throw e;
    }
  }

  // 扫描候选端口，返回第一个可握手且有响应的 CDP 端点
  async _autoFindPort() {
    const candidates = [
      this.port, 62000, 62001, 62002, 62003, 62004, 62005,
      9420, 9421, 9222, 9229,
    ].filter((v, i, a) => a.indexOf(v) === i);
    for (const p of candidates) {
      if (p === this.port) continue;
      const ok = await new Promise((resolve) => {
        let ws, settled = false;
        const fin = (r) => { if (!settled) { settled = true; try { ws && ws.close(); } catch { } resolve(r); } };
        const t = setTimeout(() => fin(false), 2000);
        try { ws = new WebSocket(`ws://127.0.0.1:${p}`); } catch { clearTimeout(t); return fin(false); }
        ws.addEventListener('open', () => {
          try { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } })); } catch { }
        });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
          if (m.id === 1 && !m.error) { clearTimeout(t); fin(true); }
        });
        ws.addEventListener('error', () => { clearTimeout(t); fin(false); });
        ws.addEventListener('close', () => { clearTimeout(t); fin(false); });
      });
      if (ok) return p;
    }
    return null;
  }

  async _dialPort(port, timeoutMs = 10000) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this._pending.clear();
    this._id = 0;
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.id && this._pending.has(m.id)) {
        const p = this._pending.get(m.id); this._pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        return;
      }
      if (m.method === 'Debugger.scriptParsed') this.scripts.push(m.params);
      if (m.method === 'Runtime.executionContextCreated') this.contexts.push(m.params.context);
    });
    ws.addEventListener('close', () => { if (this.ws === ws) this.status = 'error'; });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`CDP 连接超时 (127.0.0.1:${port})`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        rej(new Error(
          `CDP 连接失败 (127.0.0.1:${port})。\n` +
          `  请确认已启动「小程序调试端口暴露工具」并已打开游戏：\n` +
          `    · WMPFDebugger        https://github.com/evi0s/WMPFDebugger\n` +
          `    · WeChatOpenDevTools  https://github.com/JaveleyQAQ/WeChatOpenDevTools-Python\n` +
          `    · First (免安装)       D:\\first\\First.exe\n` +
          `  也可先运行 \`node tools/port-find.mjs\` 自动查找可用端口。`,
        ));
      });
    });
    this.ws = ws;
  }

  _send(method, params, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      if (!this.ws || this.ws.readyState !== 1) return rej(new Error('CDP 未连接'));
      const id = ++this._id;
      this._pending.set(id, { res, rej });
      try { this.ws.send(JSON.stringify({ id, method, params: params || {} })); }
      catch (e) { this._pending.delete(id); return rej(e); }
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); rej(new Error('CDP 超时: ' + method)); }
      }, timeoutMs);
    });
  }

  async evaluate(expression, { ctx = this.ctxId, awaitPromise = false, timeoutMs = 30000 } = {}) {
    const params = { expression, returnByValue: true, awaitPromise };
    if (ctx) params.contextId = ctx;
    const r = await this._send('Runtime.evaluate', params, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval exception');
    }
    return r.result?.value;
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch { }
    this.ws = null;
    this.status = 'idle';
  }

  // ---------- 上下文探测 ----------
  // 注意：不要清空 this.contexts。CDP 的 Runtime.enable 对「已存在」的执行上下文
  // 不会重复推送，一旦清空就再也收集不到，导致自愈时误判「游戏已关闭」。
  async detectContext() {
    await this._send('Runtime.enable').catch(() => { });
    await sleep(1200);
    const probe = `JSON.stringify({t:typeof globalThis.tsdk,c:typeof globalThis.cc,w:typeof globalThis.wx,k:Object.keys(globalThis).length})`;
    for (const c of this.contexts) {
      if (c.auxData && c.auxData.type === 'isolated') continue;
      try {
        const raw = await this.evaluate(probe, { ctx: c.id, timeoutMs: 6000 });
        if (!raw) continue;
        const j = JSON.parse(raw);
        // 游戏主上下文：有 tsdk + cc，且全局 key 数量在 100+ 量级
        if (j.t === 'object' && j.c === 'object' && j.k > 100) {
          this.ctxId = c.id;
          return { id: c.id, ok: true, info: j };
        }
      } catch { /* 该上下文不可用 */ }
    }
    throw new Error('未找到游戏主上下文（tsdk+cc）');
  }

  // ---------- 桥接健康检查 ----------
  async ping() {
    try {
      const r = await this.evaluate(
        `(function(){var b=globalThis.__bot;if(!b||typeof b.status!=='function')return 'NOBOT';var s=b.status();return s?JSON.stringify({st:s.state,cseq:s.clientSeq,url:s.url,openid:s.openid}):'NULL';})()`,
        { timeoutMs: 8000 },
      );
      if (!r || r === 'NOBOT' || r === 'NULL') return { ok: false, reason: r || 'EMPTY' };
      return { ok: true, status: JSON.parse(r) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // ---------- 抓 __netInst（断点法） ----------
  async grabNetInst({ timeoutMs = 45000, onLog = () => { } } = {}) {
    // 已有引用则直接复用
    const existing = await this.evaluate('typeof globalThis.__netInst', { timeoutMs: 6000 }).catch(() => 'undefined');
    if (existing === 'object') { onLog('__netInst 已存在，跳过断点'); return true; }

    // 收集脚本
    this.scripts = [];
    await this._send('Debugger.enable');
    await sleep(1200);
    const script = this.scripts.find(s => (s.url || '').includes('subpackages/main/game.js'))
      || this.scripts.find(s => (s.url || '').includes('usr/game.js'));
    if (!script) throw new Error('未找到游戏主脚本（subpackages/main/game.js）');
    onLog(`下断点于 scriptId=${script.scriptId}`);

    let pausedInfo = null;
    const onPaused = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.method === 'Debugger.paused' && !pausedInfo) pausedInfo = m.params;
    };
    this.ws.addEventListener('message', onPaused);

    // send 函数位置：line=2(0-based), col≈2842155（v1.14.2.13）
    const bp = await this._send('Debugger.setBreakpoint', {
      location: { scriptId: script.scriptId, lineNumber: 2, columnNumber: 2842155 },
    });

    const deadline = Date.now() + timeoutMs;
    while (!pausedInfo && Date.now() < deadline) await sleep(300);

    let grabbed = false;
    if (pausedInfo) {
      const frames = pausedInfo.callFrames || [];
      for (const f of frames) {
        if (!f.this || !f.this.objectId || f.this.type !== 'object') continue;
        try {
          const r = await this._send('Runtime.callFunctionOn', {
            objectId: f.this.objectId,
            functionDeclaration: `function(){
              try{
                var self=this,m=[],o=self,d=0;
                while(o&&d<3){for(var k of Object.getOwnPropertyNames(o)){try{if(typeof self[k]==='function'&&m.indexOf(k)<0)m.push(k);}catch(e){}}o=Object.getPrototypeOf(o);d++;}
                if(m.indexOf('send')<0) return 'SKIP';
                globalThis.__netInst=self;
                return JSON.stringify({ctor:self.constructor?self.constructor.name:'?',methods:m.slice(0,20)});
              }catch(e){return 'ERR:'+e.message;}
            }`,
            returnByValue: true,
          });
          const v = r && r.result && r.result.value;
          if (v && String(v).indexOf('SKIP') !== 0 && String(v).indexOf('ERR') !== 0) {
            grabbed = true;
            onLog('已抓取 __netInst: ' + String(v).slice(0, 120));
            break;
          }
        } catch { /* 换下一帧 */ }
      }
      await this._send('Debugger.resume').catch(() => { });
    }
    this.ws.removeEventListener('message', onPaused);
    await this._send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId }).catch(() => { });
    await this._send('Debugger.disable').catch(() => { });
    if (!grabbed) throw new Error('断点未命中或未取到网络层实例（等待 ' + Math.round(timeoutMs / 1000) + 's）');
    return true;
  }

  // ---------- 注入 __bot ----------
  async injectBot() {
    const src = readFileSync(new URL('./probe/inject_bot.js', import.meta.url), 'utf8');
    const r = await this.evaluate(src, { timeoutMs: 15000 });
    let j = null;
    try { j = JSON.parse(r); } catch { }
    if (!j || !j.ok) throw new Error('__bot 注入失败: ' + (j ? j.err : String(r).slice(0, 120)));
    return j;
  }

  // ---------- 自愈：确保桥接可用 ----------
  async ensure({ onLog = () => { } } = {}) {
    this.status = 'connecting';
    if (!this.ws || this.ws.readyState !== 1) {
      onLog(`连接 CDP ${this.url}`);
      await this._dial();
    }
    if (!this.ctxId) {
      const c = await this.detectContext();
      onLog(`游戏上下文 ctx=${c.id} (keys=${c.info.k})`);
    }
    let pong = await this.ping();
    if (pong.ok) {
      this.status = 'ready';
      return pong;
    }
    onLog(`桥接不可用 (${pong.reason})，执行自愈`);
    this.recoveries++;
    this.scripts = [];
    this.ctxId = null;          // 强制重探，但保留 this.contexts（见 detectContext 注释）
    await this.detectContext().catch(() => { });
    if (!this.ctxId) throw new Error('自愈失败：未找到游戏上下文（游戏可能已关闭）');
    await this.grabNetInst({ onLog });
    await this.injectBot();
    pong = await this.ping();
    if (!pong.ok) throw new Error('自愈失败：' + pong.reason);
    this.status = 'ready';
    return pong;
  }

  // ---------- 业务调用 ----------
  // 注意：网关应答分两层成败 —— 网络层 ok，业务层 meta.err。
  // 默认对业务错误抛异常（附 err.code），容忍错误码的调用方传 throwOnErr:false。
  async call(service, method, bodyBuf, timeoutMs = 15000, { throwOnErr = true } = {}) {
    const hex = bodyBuf && bodyBuf.length ? Buffer.from(bodyBuf).toString('hex') : '';
    const expr = `globalThis.__bot.call(${JSON.stringify(service)},${JSON.stringify(method)},${JSON.stringify(hex)},${timeoutMs}).then(r=>JSON.stringify(r))`;
    const out = await this.evaluate(expr, { awaitPromise: true, timeoutMs: timeoutMs + 5000 });
    if (!out) throw new Error(`${method}: 空响应`);
    const o = JSON.parse(out);
    if (!o.ok) {
      const err = new Error(`${method} 失败: ${o.err || 'unknown'}`);
      err.gateway = o;
      throw err;
    }
    const res = { meta: o.meta, body: o.bodyHex ? Buffer.from(o.bodyHex, 'hex') : null, bodyLen: o.bodyLen };
    if (throwOnErr && o.meta && o.meta.err) {
      const err = new Error(`${method} 业务错误 [${o.meta.err}] ${o.meta.errmsg || ''}`);
      err.gateway = o;
      err.code = o.meta.err;
      throw err;
    }
    return res;
  }

  // ---------- 从心跳解析 gid ----------
  // 心跳 body 结构：field1=gid(varint), field2=client_version(string, 形如 "1.14.2.13_20260922"), field3=0
  // 必须严格匹配这个结构 —— 只判断「首字节 0x08」会把访问好友农场的请求
  // （host_gid=好友）也抓进来，导致把自己认成好友。
  //
  // ⚠ 即便严格匹配，这个 gid 也未必是登录账号：访问好友农场时的请求同样带
  //   「gid + 版本号字符串」。实测站好友「小夏缘」的农场里启动，解析出的是
  //   小夏缘的 gid，而登录账号是 shilin。
  //   调用方必须用 Tui.refresh() 的「唯一没有 f9 农场摘要的好友条目」做校正，
  //   本方法只负责等心跳、给候选值，不作为身份的唯一来源。
  async detectGid({ waitMs = 60000, onLog = () => { } } = {}) {
    if (this.gid) return this.gid;
    onLog('等待心跳以解析 gid ...');
    await this.evaluate(
      `(function(){
        globalThis.__gids=[];
        var t=globalThis.tsdk; if(!t) return 'notsdk';
        // 若已包装过且标记仍在，无需重复包装
        if (t._encrypt_data && t._encrypt_data.__isGidHook) return 'ok';
        var H=t.HEAPU8, orig=t._encrypt_data;
        var hook=function(){ try{
          var p=arguments[0], l=arguments[1];
          if(typeof p==='number' && p>0 && l>3 && l<4096 && p+l<=H.length){
            var a=Array.prototype.slice.call(H.slice(p,p+l));
            if(a[0]===0x08){
              var i=1, gid=0, sh=0, b;
              for(;;){ b=a[i++]; gid|=(b&0x7f)<<sh; sh+=7; if(!(b&0x80))break; if(i>12)break; }
              // field2 必须是版本号字符串
              if(a[i]===0x12){
                var len=a[i+1], ver='';
                for(var k=0;k<len && i+2+k<a.length;k++) ver+=String.fromCharCode(a[i+2+k]);
                if(/^1\\.[0-9]/.test(ver)) globalThis.__gids.push(gid>>>0);
              }
            }
          }
        }catch(e){} return orig.apply(this,arguments); };
        hook.__isGidHook=true;
        t._encrypt_data=hook;
        return 'hooked'; })()`,
      { timeoutMs: 10000 },
    );

    const deadline = Date.now() + waitMs;
    let lastSeen = null;
    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        const raw = await this.evaluate(
          `(globalThis.__gids&&globalThis.__gids.length)?String(globalThis.__gids[globalThis.__gids.length-1]):''`,
          { timeoutMs: 8000 },
        );
        const n = Number(raw);
        if (n > 0) {
          this.gid = n;
          onLog('gid = ' + n);
          return n;
        }
        // 每秒汇报一次进度，避免用户以为卡死
        const el = Math.round((Date.now() - (deadline - waitMs)) / 1000);
        if (el % 10 === 0 && el !== lastSeen) { lastSeen = el; onLog(`等待心跳中... ${el}s`); }
      } catch { /* 继续等 */ }
    }
    throw new Error(
      `未能在 ${Math.round(waitMs / 1000)}s 内解析出 gid。\n` +
      `  可能原因：游戏刚重连、心跳尚未开始，或游戏已停止。\n` +
      `  可手动指定：在 TUI 里执行 /刷新 重试，或启动时加 --gid <你的gid>（可用 /好友 查看）`,
    );
  }
}

export const PHASE = { 0: 'UNKNOWN', 1: 'SEED', 2: 'GERMINATION', 3: 'SMALL_LEAVES', 4: 'LARGE_LEAVES', 5: 'BLOOMING', 6: 'MATURE', 7: 'DEAD' };
export { sleep };
