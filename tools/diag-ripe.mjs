// 逐块诊断成熟判定：对比 Phase 计算与原始数据
import { Bridge } from './core.mjs';
import { parse, fields, field, num, str, repeatedInts, decodeAllLandsReply, PHASE } from './farm.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: (m) => console.log('[log]', m) });
  const r = await b.call('gamepb.plantpb.PlantService', 'AllLands', Buffer.alloc(0));
  const now = Math.floor(Date.now() / 1000);
  console.log(`[时间] 本地 ${now}\n`);

  const rep = parse(r.body);
  const lands = decodeAllLandsReply(r.body).lands;
  const byId = new Map(lands.map(l => [l.id, l]));

  for (const bs of fields(rep, 1)) {
    const li = parse(bs);
    const id = num(li, 1);
    if (num(li, 2) === 0) continue;              // 未解锁
    const master = num(li, 13);
    const d = byId.get(id);
    const p = d?.plant;
    if (!p || !p.id) { console.log(`地${String(id).padStart(2)}  [空]  ${master ? '副产→' + master : '主地'}`); continue; }

    const pb = fields(li, 10)[0];
    const pi = parse(pb);
    const phases = fields(pi, 4).map(x => {
      const ph = parse(x);
      return { phase: num(ph, 1), begin: num(ph, 2) };
    });

    const role = master ? `副产→${master}` : '主地';
    console.log(`地${String(id).padStart(2)}  ${String(p.name).padEnd(12)} ${role}`);
    console.log(`     解析: currentPhase=${p.currentPhase}(${PHASE[p.currentPhase]}) isRipe=${p.isRipe} ripeAt=${p.ripeAt} (${p.ripeAt > now ? '还有 ' + (p.ripeAt - now) + 's' : '已过 ' + (now - p.ripeAt) + 's'})`);
    console.log(`     果实: left=${p.leftFruitNum} fruit=${p.fruitNum} growSec=${p.growSec} stealable=${p.stealable}`);
    console.log(`     phases(${phases.length}): ` + phases.map(x => `${PHASE[x.phase]}@${x.begin - now > 0 ? '+' + (x.begin - now) : (x.begin - now)}s`).join('  '));
    console.log('');
  }
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
