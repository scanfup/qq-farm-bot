import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FarmApp, AppError, COMMANDS, FRIEND_READ_COMMANDS, PASTURE_READ_COMMANDS } from './service.mjs';
import { Bridge } from '../tools/core.mjs';

export function createServer(app) {
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address().port;
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowed.includes(req.headers.host)) throw new AppError('Host 不允许', 403);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new AppError('跨站访问不允许', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('跨站访问不允许', 403);
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && path === '/api/state') return json(200, app.state());
      if (req.method === 'GET' && path === '/api/events') {
        if (streams.size >= 20) throw new AppError('实时连接数量已达上限', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        streams.add(res);
        const push = state => { if (res.writableLength > 1024 * 1024) { res.destroy(); return; } res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); };
        app.listeners.add(push); push(app.state());
        const tick = setInterval(() => res.write(': heartbeat\n\n'), 15000); tick.unref();
        res.on('close', () => { clearInterval(tick); app.listeners.delete(push); streams.delete(res); }); return;
      }
      if (req.method === 'POST') {
        if (req.headers['x-farm-request'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('请求必须使用 JSON 和 X-Farm-Request', 403);
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw new AppError('请求过大', 413); }
        let data; try { data = JSON.parse(body || '{}'); } catch { throw new AppError('JSON 格式错误'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('请求应为对象');
        if (path === '/api/connect') return json(202, app.submit('connect'));
        if (path === '/api/refresh') return json(202, app.submit('refresh'));
        if (path === '/api/commands') {
          if (![...COMMANDS, ...FRIEND_READ_COMMANDS, ...PASTURE_READ_COMMANDS].includes(data.type) || typeof data.commandId !== 'string') throw new AppError('必须提供合法 type 和 commandId');
          return json(202, app.submit(data.type, { seedId: data.seedId, gid: data.gid, animalId:data.animalId, count:data.count, limit:data.limit, maxFriends:data.maxFriends, expectedUnitPrice:data.expectedUnitPrice }, data.commandId));
        }
        if (path === '/api/preferences') return json(200, app.setPreferences(data));
        if (path === '/api/monitor') return json(200, app.setMonitor(data));
        const sceneMonitor = /^\/api\/monitor\/(farm|pasture)$/.exec(path);
        if (sceneMonitor) return json(200, app.setSceneMonitor(sceneMonitor[1], data));
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/navigation.js': ['navigation.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && files[path]) {
        const [file, mime] = files[path]; res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
        return res.end(readFileSync(new URL('./public/' + file, import.meta.url)));
      }
      json(404, { error: '接口不存在' });
    } catch (error) { if (!res.headersSent) json(error.status || 500, { error: app.sanitize(error.message) }); else res.end(); }
  });
  server.closeStreams = () => { for (const res of streams) res.end(); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = process.argv.includes('--demo');
  const port = Number(process.env.WEB_PORT || (demo ? 3211 : 3210));
  const cdpPort = Number(process.env.CDP_PORT || 62000);
  const gid = process.env.MY_GID ? Number(process.env.MY_GID) : 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535 || !Number.isSafeInteger(gid) || gid < 0) throw new Error('WEB_PORT / CDP_PORT / MY_GID 配置无效');
  const app = new FarmApp({ demo, bridge: new Bridge({ port: cdpPort, gid }) });
  const server = createServer(app);
  server.on('error', error => { console.error('Web 服务启动失败：' + error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`QQ 农场 ${demo ? '演示' : 'CDP'} 面板：http://127.0.0.1:${port}`));
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; server.closeStreams(); server.close(); await app.close(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
