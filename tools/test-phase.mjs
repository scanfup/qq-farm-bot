import { Bridge } from './core.mjs';
import { parse, fields, num, str, decodeAllLandsReply, PHASE } from './farm.mjs';

const b = new Bridge({ port: 62000 });
try {
  await b.ensure({ onLog: (m) => console.log('[log]', m) });
  const r = await b.call('gamepb.plantpb.PlantService', 'AllLands', Buffer.alloc(0));
  const nowSec = Math.floor(Date.now() / 1000);
  console.log('本地时间戳 =', nowSec);

  const rep = parse(r.body);
  for (const bs of fields(rep, 1)) {
    const li = parse(bs);
    const id = num(li, 1);
    const unlocked = num(li, 2) !== 0;
    if (!unlocked) continue;
    const pb = fields(li, 10)[0];
    if (!pb) { console.log(`地${id} 空`); continue; }
    const p = parse(pb);
    const nm = str(p, 2);
    const phases = fields(p, 4).map(x => {
      const ph = parse(x);
      return { phase: num(ph, 1), begin: num(ph, 2), phaseId: num(ph, 3), dry: num(ph, 6), weeds: num(ph, 7), insect: num(ph, 8) };
    });
    const cur = decodeAllLandsReply(r.body).lands.find(l => l.id === id);
    console.log(`\n地${id} ${nm}  阶段数=${phases.length}  解析 lastPhase=${cur.plant.lastPhase}(${PHASE[cur.plant.lastPhase]})`);
    for (const ph of phases) {
      const rel = ph.begin - nowSec;
      console.log(`   phase=${ph.phase}(${PHASE[ph.phase]}) begin=${ph.begin} ${rel > 0 ? '(未来 +' + rel + 's)' : '(已过 ' + (-rel) + 's)'} phaseId=${ph.phaseId}`);
    }
    // PlantInfo 其它可能有用的字段
    const extra = {};
    for (const f of p) {
      if ([1, 2, 4, 5].includes(f.no)) continue;
      extra['f' + f.no] = f.wire === 0 ? Number(f.v) : (f.wire === 2 ? 'len' + f.v.length : '?');
    }
    console.log('   其它字段:', JSON.stringify(extra).slice(0, 300));
  }
} catch (e) { console.log('[FAIL]', e.message); }
finally { b.close(); setTimeout(() => process.exit(0), 120); }
