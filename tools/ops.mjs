// 写操作验证器：操作前后状态对比
// 用法:
//   node tools/ops.mjs harvest                      # 收获所有成熟地块
//   node tools/ops.mjs plant <seedId>               # 种植所有空地
//   node tools/ops.mjs friends                      # 拉好友列表
//   node tools/ops.mjs put-insects <gid> [landIds]  # 撒虫（逗号分隔）
//   node tools/ops.mjs put-weeds  <gid> [landIds]   # 撒草
import { botCall, buildHarvest, buildPlant, buildPutItem, buildVisitEnter, buildVisitLeave, buildRemovePlant, buildFarming, decodeFarmingReply, decodeAllLandsReply, parse, fields, num, str, repeatedInts, PHASE, closeConn } from './farm.mjs';

const GID = Number(process.env.MY_GID || 1229136306);
const PLANT_SVC = 'gamepb.plantpb.PlantService';
const FRIEND_SVC = 'gamepb.friendpb.FriendService';

async function snapshot() {
  const r = await botCall(PLANT_SVC, 'AllLands', Buffer.alloc(0));
  if (!r.ok) throw new Error('AllLands failed: ' + r.err);
  return decodeAllLandsReply(r.body);
}

function brief(d) {
  const ripe = [], empty = [];
  for (const l of d.lands) {
    if (!l.unlocked) continue;
    if (!l.plant || !l.plant.id) empty.push(l.id);
    else if (l.plant.isRipe) ripe.push(l.id);
  }
  const lim = {};
  for (const x of d.limits) lim[x.id] = x.dayTimes;
  return { ripe, empty, lim };
}

function diffLimit(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.lim), ...Object.keys(b.lim)])) {
    const x = a.lim[k], y = b.lim[k];
    if (x !== y) out.push(`id${k}: ${x}→${y}`);
  }
  return out;
}

const cmd = process.argv[2];

if (cmd === 'harvest') {
  const before = await snapshot();
  const b = brief(before);
  console.log('[before] 成熟:', b.ripe.join(',') || '无');
  if (!b.ripe.length) { console.log('没有可收获的地块，退出'); process.exit(0); }

  const body = buildHarvest(b.ripe, GID, true);
  console.log('[req] Harvest land_ids=[' + b.ripe.join(',') + '] host_gid=' + GID + ' is_all=true');
  console.log('[reqHex]', body.toString('hex'));

  const r = await botCall(PLANT_SVC, 'Harvest', body);
  console.log('[resp] ok=' + r.ok, r.err || '', 'meta=' + JSON.stringify(r.meta));
  if (r.body) {
    console.log('[respLen]', r.body.length);
    const rep = parse(r.body);
    const lands = fields(rep, 1).map(bs => { const li = parse(bs); return num(li, 1); });
    console.log('[resp] 回包含土地:', lands.join(',') || '(无)');
    const lim = fields(rep, 4).map(bs => { const l = parse(bs); return `id${num(l, 1)}:${num(l, 2)}`; });
    if (lim.length) console.log('[resp] operation_limits:', lim.join(' '));
  }

  await new Promise(r => setTimeout(r, 1200));
  const after = await snapshot();
  const a = brief(after);
  console.log('[after ] 成熟:', a.ripe.join(',') || '无');
  console.log('[after ] 空地:', a.empty.join(',') || '无');
  console.log('\n=== 判定 ===');
  const gone = b.ripe.filter(x => !a.ripe.includes(x));
  console.log('已收获地块:', gone.join(',') || '(无)');
  console.log('额度变化:', diffLimit(b, a).join(' ') || '(无)');
  console.log(gone.length ? '★★★ 收获验证通过' : '✗ 未生效');

} else if (cmd === 'plant') {
  const seedId = Number(process.argv[3] || 1020516);
  const landArg = process.argv[4];
  const before = await snapshot();
  const b = brief(before);
  console.log('[before] 空地:', b.empty.join(',') || '无');
  const targets = landArg ? landArg.split(',').map(Number) : b.empty;
  if (!targets.length) { console.log('没有可种地块，退出'); closeConn(); process.exit(0); }

  const body = buildPlant(seedId, targets, false);
  console.log('[req] Plant seed_id=' + seedId + ' land_ids=[' + targets.join(',') + ']');
  console.log('[reqHex]', body.toString('hex'));

  const r = await botCall(PLANT_SVC, 'Plant', body);
  console.log('[resp] ok=' + r.ok, r.err || '', 'meta=' + JSON.stringify(r.meta));
  if (r.body) console.log('[respLen]', r.body.length);

  await new Promise(r => setTimeout(r, 1200));
  const after = await snapshot();
  const a = brief(after);
  console.log('[after ] 空地:', a.empty.join(',') || '无');
  console.log('\n=== 判定 ===');
  const planted = b.empty.filter(x => !a.empty.includes(x));
  console.log('已种下地块:', planted.join(',') || '(无)');
  for (const l of after.lands) {
    if (planted.includes(l.id) && l.plant) {
      console.log(`   地${l.id}: ${l.plant.name} (id=${l.plant.id}) phase=${l.plant.lastPhaseName}`);
    }
  }
  console.log(planted.length ? '★★★ 种植验证通过' : '✗ 未生效');

} else if (cmd === 'friends') {
  const r = await botCall(FRIEND_SVC, 'GetAll', Buffer.alloc(0));
  console.log('[resp] ok=' + r.ok, r.err || '');
  if (!r.ok) process.exit(1);
  const rep = parse(r.body);
  const gs = fields(rep, 1);
  console.log('[friends]', gs.length);
  for (const bs of gs) {
    const f = parse(bs);
    const pl = fields(f, 9)[0];
    let plantInfo = '';
    if (pl) {
      const p = parse(pl);
      plantInfo = `ripe=${num(p, 4)} stealable=${num(p, 6)} weed=${num(p, 8)} insect=${num(p, 9)}`;
    }
    console.log(`  gid=${num(f, 1)} name=${str(f, 3)} lv=${num(f, 6)} ${plantInfo}`);
  }
  console.log('[appCount]', num(rep, 3));

} else if (cmd === 'put-insects' || cmd === 'put-weeds') {
  const targetGid = Number(process.argv[3]);
  const landArg = process.argv[4];
  if (!targetGid) { console.log('usage: node tools/ops.mjs ' + cmd + ' <gid> [landIds]'); process.exit(1); }
  const method = cmd === 'put-insects' ? 'PutInsects' : 'PutWeeds';

  // 若未指定地块，先 Enter 好友农场取土地列表
  let landIds = landArg ? landArg.split(',').map(Number) : null;
  if (!landIds) {
    const er = await botCall('gamepb.visitpb.VisitService', 'Enter', buildVisitEnter(targetGid));
    console.log('[Enter] ok=' + er.ok, er.err || '', 'len=' + (er.body ? er.body.length : 0));
    if (er.ok && er.body) {
      const rep = parse(er.body);
      const landsBs = fields(rep, 2);
      const info = [];
      for (const bs of landsBs) {
        const li = parse(bs);
        const id = num(li, 1);
        const unlocked = num(li, 2) !== 0;
        const plantBs = fields(li, 10)[0];
        let weed = 0, insect = 0, phase = 0, nm = '';
        if (plantBs) {
          const p = parse(plantBs);
          nm = str(p, 2);
          weed = repeatedInts(p, 12).length;
          insect = repeatedInts(p, 13).length;
          const ph = fields(p, 4);
          if (ph.length) { const last = parse(ph[ph.length - 1]); phase = num(last, 1); }
        }
        info.push({ id, unlocked, weed, insect, phase, nm });
      }
      console.log('[好友土地]');
      for (const i of info) console.log(`   地${i.id} unlocked=${i.unlocked} ${i.nm || '(空)'} phase=${PHASE[i.phase] || i.phase} 草${i.weed} 虫${i.insect}`);
      // ★ 草虫各占独立槽位：已有虫不能再撒虫、已有草不能再撒草
      const needFree = method === 'PutInsects' ? 'insect' : 'weed';
      landIds = info
        .filter(i => i.unlocked && i.nm && (needFree === 'insect' ? i.insect === 0 : i.weed === 0))
        .map(i => i.id)
        .slice(0, Number(process.env.MAX_PER_FRIEND || 3));
      console.log(`[选中] ${needFree === 'insect' ? '无虫' : '无草'}的 ${landIds.length} 块: ${landIds.join(',') || '(无)'}`);
    }
  }
  if (!landIds || !landIds.length) { console.log('无可操作地块'); process.exit(0); }

  for (const lid of landIds) {
    const body = buildPutItem(targetGid, [lid]);
    console.log(`\n--- 地${lid} ---`);
    console.log('[reqHex]', body.toString('hex'));
    const r = await botCall(PLANT_SVC, method, body);
    console.log('[resp] ok=' + r.ok, r.err || '', 'meta=' + JSON.stringify(r.meta));
    if (r.ok && r.body) {
      const rep = parse(r.body);
      const lands = fields(rep, 1).map(bs => { const li = parse(bs); return num(li, 1); });
      const lim = fields(rep, 2).map(bs => { const l = parse(bs); return `id${num(l, 1)}:${num(l, 2)}/${num(l, 3)}`; });
      console.log('[resp] land:', lands.join(',') || '(空)', '| limits:', lim.join(' '));
    }
    await new Promise(r => setTimeout(r, 150));
  }
  // 离开好友农场
  try {
    const rr = await botCall('gamepb.visitpb.VisitService', 'Leave', buildVisitLeave(targetGid));
    console.log('\n[Leave] ok=' + rr.ok);
  } catch (e) { console.log('[Leave] err', e.message); }

} else if (cmd === 'farming' || cmd === 'farming-self') {
  const selfMode = cmd === 'farming-self';
  const targetGid = selfMode ? GID : Number(process.argv[3]);
  if (!targetGid) { console.log('usage: node tools/ops.mjs farming <gid>  |  farming-self'); process.exit(1); }
  let landsBs = null;
  if (selfMode) {
    const ar = await botCall(PLANT_SVC, 'AllLands', Buffer.alloc(0));
    landsBs = fields(parse(ar.body), 1);
  } else {
    const er = await botCall('gamepb.visitpb.VisitService', 'Enter', buildVisitEnter(targetGid));
    console.log('[Enter] ok=' + er.ok, 'len=' + (er.body ? er.body.length : 0));
    if (!er.ok) { closeConn(); process.exit(1); }
    landsBs = fields(parse(er.body), 2);
  }
  const cand = [];
  for (const bs of landsBs) {
    const li = parse(bs);
    if (num(li, 2) === 0) continue;          // 未解锁
    if (num(li, 13) !== 0) continue;         // 副产地不可单独操作
    const pb = fields(li, 10)[0];
    if (!pb) continue;
    const p = parse(pb);
    const weedN = repeatedInts(p, 12).length;
    const insectN = repeatedInts(p, 13).length;
    if (weedN > 0 || insectN > 0) cand.push({ id: num(li, 1), weedN, insectN });
  }
  console.log('[待清理]', cand.map(c => `地${c.id}(草${c.weedN}虫${c.insectN})`).join(' ') || '无');
  if (cand.length) {
    const body = buildFarming(cand.map(c => c.id), targetGid, !selfMode);
    console.log('[reqHex]', body.toString('hex'));
    const r = await botCall(PLANT_SVC, 'Farming', body);
    console.log('[resp] ok=' + r.ok, r.err || '', JSON.stringify(r.meta));
    if (r.ok && r.body) {
      const d = decodeFarmingReply(r.body);
      console.log('[resp] 清理:', d.results.map(x => '地' + x.landId + (x.reward ? `(奖励${x.reward.id}x${x.reward.count})` : '')).join(' ') || '(无)');
      console.log('[resp] limits:', d.limits.map(l => `id${l.id}:${l.dayTimes}/${l.dayLimit}`).join(' ') || '(无)');
    }
  }
  if (!selfMode) await botCall('gamepb.visitpb.VisitService', 'Leave', buildVisitLeave(targetGid));

} else if (cmd === 'visit') {
  const gid = Number(process.argv[3]);
  const er = await botCall('gamepb.visitpb.VisitService', 'Enter', buildVisitEnter(gid));
  console.log('[Enter] ok=' + er.ok, 'len=' + (er.body ? er.body.length : 0));
  if (er.ok && er.body) {
    const rep = parse(er.body);
    for (const bs of fields(rep, 2)) {
      const li = parse(bs);
      const id = num(li, 1);
      const unlocked = num(li, 2) !== 0;
      if (!unlocked) continue;
      const plantBs = fields(li, 10)[0];
      let weed = 0, insect = 0, phase = 0, nm = '';
      if (plantBs) {
        const p = parse(plantBs);
        nm = str(p, 2);
        weed = repeatedInts(p, 12).length;
        insect = repeatedInts(p, 13).length;
        const ph = fields(p, 4);
        if (ph.length) { const last = parse(ph[ph.length - 1]); phase = num(last, 1); }
      }
      console.log(`   地${String(id).padStart(2)} ${(nm || '(空)').padEnd(12)} phase=${(PHASE[phase] || phase)} 草${weed} 虫${insect}`);
    }
  }
  await botCall('gamepb.visitpb.VisitService', 'Leave', buildVisitLeave(gid));
  console.log('[Leave] done');

} else {
  console.log(`用法:
  node tools/ops.mjs harvest
  node tools/ops.mjs plant <seedId> [landIds]
  node tools/ops.mjs friends
  node tools/ops.mjs visit <gid>
  node tools/ops.mjs put-insects <gid> [landIds]
  node tools/ops.mjs put-weeds  <gid> [landIds]`);
}
closeConn();
process.exit(0);
