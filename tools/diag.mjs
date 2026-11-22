// 诊断：检查页面内 hook 与注入状态
import { Bridge } from './core.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: (m) => console.log('[log]', m) });
  console.log('[ctx]', b.ctxId);

  const expr = [
    'JSON.stringify({',
    '  gidhook: typeof globalThis.__gidhook,',
    '  gidsLen: globalThis.__gids ? globalThis.__gids.length : null,',
    '  gidsLast: globalThis.__gids ? globalThis.__gids.slice(-3) : null,',
    '  hasTsdk: typeof globalThis.tsdk,',
    '  encType: globalThis.tsdk ? typeof globalThis.tsdk._encrypt_data : null,',
    '  encMarked: globalThis.tsdk && globalThis.tsdk._encrypt_data ? !!globalThis.tsdk._encrypt_data.__isGidHook : null,',
    '  encSrc: globalThis.tsdk && globalThis.tsdk._encrypt_data ? String(globalThis.tsdk._encrypt_data).slice(0,80) : null,',
    '  netInst: typeof globalThis.__netInst,',
    '  bot: typeof globalThis.__bot,',
    '  cseq: globalThis.__netInst ? globalThis.__netInst.clientSeq : null',
    '})',
  ].join('\n');

  const raw = await b.evaluate(expr, { timeoutMs: 15000 });
  console.log('[page]', raw);

  // 等一次心跳，看 hook 是否真的在收数据
  console.log('\n[wait] 观察 30s 内是否捕获心跳...');
  await b.evaluate('(globalThis.__gids = [], "cleared")', { timeoutMs: 8000 });
  for (let i = 1; i <= 6; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const g = await b.evaluate('globalThis.__gids ? globalThis.__gids.length : -1', { timeoutMs: 8000 });
    const c = await b.evaluate('globalThis.__netInst ? globalThis.__netInst.clientSeq : -1', { timeoutMs: 8000 });
    console.log(`  t=${i * 5}s  gids捕获=${g}  clientSeq=${c}`);
  }
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
