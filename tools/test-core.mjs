import { Bridge } from './core.mjs';

const log = (m) => console.log('[log]', m);
const t0 = Date.now();
const b = new Bridge();

try {
  const r = await b.ensure({ onLog: log });
  console.log('[ensure]', JSON.stringify(r, null, 1), `(${Date.now() - t0}ms)`);
  console.log('[ctx]', b.ctxId);

  const ping = await b.ping();
  console.log('[ping]', JSON.stringify(ping));

  const gid = await b.detectGid({ onLog: log, waitMs: 32000 });
  console.log('[gid]', gid);

  const rep = await b.call('gamepb.plantpb.PlantService', 'AllLands', Buffer.alloc(0));
  console.log('[AllLands] bodyLen =', rep.body.length, 'meta =', JSON.stringify(rep.meta));
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 100);
}
