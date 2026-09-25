// 通用 protobuf 编解码 + 农场状态解析 + 写操作请求构造
// 用法:
//   node tools/farm.mjs state               # 拉取并解析自家土地
//   node tools/farm.mjs probe <hex>         # 解析任意 hex
import { readFileSync } from 'node:fs';

// ==================== protobuf 原语 ====================
export function readVarint(b, p) {
  let r = 0n, s = 0n, byte;
  do { byte = b[p++]; r |= BigInt(byte & 0x7f) << s; s += 7n; } while (byte & 0x80);
  return [r, p];
}

export function parse(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p < end) {
    let tag; [tag, p] = readVarint(buf, p);
    const no = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 0) { let v; [v, p] = readVarint(buf, p); out.push({ no, wire, v }); }
    else if (wire === 1) { out.push({ no, wire, v: buf.subarray(p, p + 8) }); p += 8; }
    else if (wire === 2) {
      let len; [len, p] = readVarint(buf, p);
      const L = Number(len);
      out.push({ no, wire, v: buf.subarray(p, p + L) });
      p += L;
    }
    else if (wire === 5) { out.push({ no, wire, v: buf.readUInt32LE(p) }); p += 4; }
    else throw new Error(`unsupported wire type ${wire} at ${p} (field ${no})`);
  }
  return out;
}

export const fields = (list, no) => list.filter(f => f.no === no).map(f => f.v);
export const field = (list, no) => { const a = fields(list, no); return a.length ? a[a.length - 1] : undefined; };
export const num = (list, no, d = 0) => { const v = field(list, no); return v === undefined ? d : Number(v); };
export const str = (list, no) => { const v = field(list, no); return v === undefined ? '' : Buffer.from(v).toString('utf8'); };

// 解析 packed 或非 packed 的 repeated int64
export function packedInts(bs) {
  if (!bs) return [];
  const out = []; let p = 0;
  try { while (p < bs.length) { let v; [v, p] = readVarint(bs, p); out.push(Number(v)); } }
  catch (e) { return out; }
  return out;
}
export function repeatedInts(list, no) {
  const out = [];
  for (const f of list) {
    if (f.no !== no) continue;
    if (f.wire === 0) out.push(Number(f.v));
    else if (f.wire === 2) out.push(...packedInts(f.v));
  }
  return out;
}

// ==================== 编码器 ====================
export function wVarint(fieldNo, value) {
  const out = []; let v = BigInt(value);
  out.push(...varintBytes(BigInt(fieldNo * 8)));
  out.push(...varintBytes(v));
  return Buffer.from(out);
}
export function varintBytes(v) {
  const out = []; let n = BigInt(v);
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; out.push(b); } while (n > 0n);
  return out;
}
export function wBytes(fieldNo, buf) {
  return Buffer.concat([
    Buffer.from(varintBytes(BigInt(fieldNo * 8 + 2))),
    Buffer.from(varintBytes(BigInt(buf.length))),
    buf,
  ]);
}
export function wPackedInts(fieldNo, arr) {
  const body = Buffer.concat(arr.map(x => Buffer.from(varintBytes(BigInt(x)))));
  return wBytes(fieldNo, body);
}
export function wMsg(fieldNo, buf) { return wBytes(fieldNo, buf); }
export const encCat = (...bufs) => Buffer.concat(bufs);

// ==================== 农场业务解析 ====================
export const PHASE = { 0: 'UNKNOWN', 1: 'SEED', 2: 'GERMINATION', 3: 'SMALL_LEAVES', 4: 'LARGE_LEAVES', 5: 'BLOOMING', 6: 'MATURE', 7: 'DEAD' };

export function decodePlantInfo(bs, nowSec) {
  if (!bs) return null;
  const pi = parse(bs);
  const now = Number(nowSec) || Math.floor(Date.now() / 1000);
  const phasesRaw = fields(pi, 4);
  const phases = phasesRaw.map(pb => {
    const ph = parse(pb);
    return {
      phase: num(ph, 1),
      phaseName: PHASE[num(ph, 1)] || '?',
      beginTime: num(ph, 2),
      phaseId: num(ph, 3),
      dryTime: num(ph, 6),
      weedsTime: num(ph, 7),
      insectTime: num(ph, 8),
    };
  });
  // ★ phases 里同时含「当前阶段」和「未来阶段的预测」，不能取最后一条。
  //   当前阶段 = 最后一个 begin_time <= now 的条目。
  let curPhaseObj = null;
  for (const ph of phases) if (ph.beginTime > 0 && ph.beginTime <= now) curPhaseObj = ph;
  if (!curPhaseObj && phases.length) curPhaseObj = phases[0];
  const cur = curPhaseObj ? curPhaseObj.phase : 0;

  const matureEntry = phases.find(ph => ph.phase === 6);
  const ripeAt = matureEntry ? matureEntry.beginTime : 0;

  // 旱 / 草 / 虫 的到期时间由服务端在阶段里给出（绝对 unix 秒），到点即生效。
  // ⚠ weed_owners / insect_owners 只记录「谁放的」，自然长出的草虫没有 owner，
  //   仅凭 owners 判断会漏掉自然发生的旱草虫 —— 这是务农「有得做却报无可用」的原因。
  const due = (t) => t > 0 && t <= now;
  const needWater = !!curPhaseObj && due(curPhaseObj.dryTime);
  const needWeed = !!curPhaseObj && due(curPhaseObj.weedsTime);
  const needInsect = !!curPhaseObj && due(curPhaseObj.insectTime);

  return {
    id: num(pi, 1),
    name: str(pi, 2),
    phases,
    lastPhase: cur,
    lastPhaseName: PHASE[cur] || '?',
    currentPhase: cur,
    curPhaseObj,
    ripeAt,
    isRipe: ripeAt > 0 && ripeAt <= now,
    ripeInSec: ripeAt > now ? ripeAt - now : 0,
    needWater,
    needWeed,
    needInsect,
    needCare: needWater || needWeed || needInsect,
    // 顶层 field 6：语义未确认，实测恒为 0，不要拿它当干旱标记
    field6: num(pi, 6),
    stoleNum: num(pi, 9),
    fruitId: num(pi, 10),
    fruitNum: num(pi, 11),
    weedOwners: repeatedInts(pi, 12),
    insectOwners: repeatedInts(pi, 13),
    growSec: num(pi, 15),
    stealable: num(pi, 16) !== 0,
    leftFruitNum: num(pi, 18),
  };
}

export function decodeLandInfo(bs, nowSec) {
  const li = parse(bs);
  const plantBs = field(li, 10);
  return {
    id: num(li, 1),
    unlocked: num(li, 2) !== 0,
    level: num(li, 3),
    maxLevel: num(li, 4),
    couldUnlock: num(li, 5) !== 0,
    couldUpgrade: num(li, 6) !== 0,
    isShared: num(li, 11) !== 0,
    canShare: num(li, 12) !== 0,
    masterLandId: num(li, 13),          // 主地 ID（0=自己是主地）
    slaveLandIds: repeatedInts(li, 14), // 副产地 ID 列表
    landSize: num(li, 15),
    plant: plantBs ? decodePlantInfo(plantBs, nowSec) : null,
  };
}

export function decodeAllLandsReply(buf, nowSec) {
  // 空响应（ok=true 但 body 为空）会拿到 null，parse(null) 会直接抛
  // "Cannot read properties of null" 把整条挂机循环打死，这里做容错。
  if (!buf || !buf.length) return { lands: [], limits: [], socialEvents: 0, empty: true };
  const r = parse(buf);
  const lands = fields(r, 1).map(bs => decodeLandInfo(bs, nowSec));
  const limits = fields(r, 2).map(bs => {
    const l = parse(bs);
    return { id: num(l, 1), dayTimes: num(l, 2), dayLimit: num(l, 3) };
  });
  return { lands, limits, socialEvents: fields(r, 3).length };
}

// 语义便捷判断
export const isRipe = (land) => !!(land && land.plant && land.plant.isRipe);
export const isDead = (land) => !!(land && land.plant && land.plant.id && land.plant.currentPhase === 7);
export const isEmpty = (land) => !!(land && land.unlocked && (!land.plant || !land.plant.id));
// ★ 主地判定：副产地（master_land_id != 0）的作物是主地的影子，
//   收获/铲除/种植都必须只针对主地，副产由 auto_slave 自动跟随。
export const isMainLand = (land) => !!(land && land.masterLandId === 0);
export const isSlaveLand = (land) => !!(land && land.masterLandId !== 0);

// BagReply { corepb.ItemBag item_bag = 1 }
//   ItemBag { repeated Item items=1; capacity=2; used_slots=3 }
//   Item    { id=1; count=2; expire_time=3; uid=6; is_new=7 }
export function decodeBagReply(buf) {
  if (!buf || !buf.length) return { items: [], capacity: 0, usedSlots: 0, empty: true };
  const r = parse(buf);
  const bagBs = field(r, 1);
  if (!bagBs) return { items: [], capacity: 0, usedSlots: 0 };
  const bag = parse(bagBs);
  const items = fields(bag, 1).map(bs => {
    const it = parse(bs);
    return { id: num(it, 1), count: num(it, 2), uid: num(it, 6), isNew: num(it, 7) !== 0 };
  });
  return { items, capacity: num(bag, 2), usedSlots: num(bag, 3) };
}

// ==================== 请求构造 ====================
// HarvestRequest { land_ids=1(repeated), host_gid=2, is_all=3 }
// ★ 实测关键：收获「自家」作物时不能带 host_gid。
//   带上 host_gid（哪怕是自己的 gid 或 0）会让服务端按访客/偷菜路径校验，
//   把正常成熟的地块判为 1001021「作物未成熟」甚至 1001022「作物已枯萎」。
//   自家收获只传 land_ids 即可；偷菜（收好友的）才需要 host_gid。
export function buildHarvest(landIds, hostGid = 0, isAll = false) {
  const parts = [];
  if (landIds.length) parts.push(wPackedInts(1, landIds));
  if (hostGid) parts.push(wVarint(2, hostGid));   // 仅偷菜时编码
  if (isAll) parts.push(wVarint(3, 1));           // 自家收获不编码该字段
  return encCat(...parts);
}

// PlantRequest { repeated PlantItem items = 2 }
//   PlantItem { seed_id=1, land_ids=2(packed), auto_slave=3 }
// 实测 v1.14.2.13：必须「每块地一个独立 PlantItem」。
// 若用单个 PlantItem 挂多个 land_ids，服务端返回 error 1000020 请求参数错误。
export function buildPlant(seedId, landIds, autoSlave = false) {
  return encCat(...landIds.map((id) => wMsg(2, encCat(
    wVarint(1, seedId),
    wPackedInts(2, [id]),
    autoSlave ? wVarint(3, 1) : Buffer.alloc(0),
  ))));
}

// PutInsectsRequest / PutWeedsRequest { host_gid=1, land_ids=2(repeated) }
export function buildPutItem(hostGid, landIds) {
  return encCat(wVarint(1, hostGid), landIds.length ? wPackedInts(2, landIds) : Buffer.alloc(0));
}

// VisitEnterRequest { host_gid=1, reason=2 }   reason: 2=ENTER_REASON_FRIEND
export function buildVisitEnter(hostGid, reason = 2) {
  return encCat(wVarint(1, hostGid), wVarint(2, reason));
}

// VisitLeaveRequest { host_gid=1 }
export function buildVisitLeave(hostGid) {
  return wVarint(1, hostGid);
}

// RemovePlantRequest { repeated int64 land_ids = 1 }
// 实测：收获后地块进入 DEAD（枯株）状态，必须 RemovePlant 才回到空地，否则无法补种。
export function buildRemovePlant(landIds) {
  return landIds.length ? wPackedInts(1, landIds) : Buffer.alloc(0);
}

// ---- 务农 Farming：清除地块上的草/虫（与 PutInsects/PutWeeds「放置」互补）----
// FarmingRequest { land_ids=1(packed); host_gid=2; field_3=3; field_4=4; social_event_item_ids=5(packed) }
//   field_4 场景字段必须显式编码：0=自家务农，2=帮好友务农。
//   官方抓包会写出 field_3=0 / field_4=0，不能依赖 proto3 默认省略。
//   与放虫放草不同，Farming 一次可提交多个 land_ids。
export function buildFarming(landIds, hostGid, isHelp = false, socialEventItemIds = []) {
  const parts = [
    landIds.length ? wPackedInts(1, landIds) : Buffer.alloc(0),
    wVarint(2, hostGid),
    wVarint(3, 0),
    wVarint(4, isHelp ? 2 : 0),
  ];
  if (socialEventItemIds.length) parts.push(wPackedInts(5, socialEventItemIds));
  return encCat(...parts);
}

// FarmingReply { land=1; operation_limits=2; results=3; social_event_rewards=4 }
export function decodeFarmingReply(buf) {
  if (!buf || !buf.length) return { results: [], limits: [], landCount: 0, empty: true };
  const r = parse(buf);
  const results = fields(r, 3).map(bs => {
    const x = parse(bs);
    const item = field(x, 2);
    let reward = null;
    if (item) { const it = parse(item); reward = { id: num(it, 1), count: num(it, 2) }; }
    return { landId: num(x, 1), reward };
  });
  const limits = fields(r, 2).map(bs => { const l = parse(bs); return { id: num(l, 1), dayTimes: num(l, 2), dayLimit: num(l, 3) }; });
  return { results, limits, landCount: fields(r, 1).length };
}

// ---- 商店（shop_id: 1=道具 2=种子 3=宠物）----
// BuyGoodsRequest { goods_id=1, num=2, price=3 }
export function buildBuyGoods(goodsId, num, price) {
  return encCat(wVarint(1, goodsId), wVarint(2, num), wVarint(3, price));
}
// ShopInfoRequest { shop_id=1 }
export function buildShopInfo(shopId) {
  return wVarint(1, shopId);
}
// ShopInfoReply { repeated GoodsInfo goods_list = 1 }
//   GoodsInfo { id=1; bought_num=2; price=3; limit_count=4; unlocked=5; item_id=6; item_count=7; conds=8 }
export function decodeShopReply(buf) {
  if (!buf || !buf.length) return [];
  const r = parse(buf);
  return fields(r, 1).map(bs => {
    const g = parse(bs);
    const conds = fields(g, 8).map(cb => { const c = parse(cb); return { type: num(c, 1), param: num(c, 2) }; });
    return {
      id: num(g, 1), boughtNum: num(g, 2), price: num(g, 3), limitCount: num(g, 4),
      unlocked: num(g, 5) !== 0, itemId: num(g, 6), itemCount: num(g, 7), conds,
    };
  });
}
// BuyGoodsReply { GoodsInfo goods=1; repeated Item get_items=2; repeated Item cost_items=3 }
export function decodeBuyReply(buf) {
  if (!buf || !buf.length) return { get: [], cost: [], empty: true };
  const r = parse(buf);
  const rd = (no) => fields(r, no).map(bs => { const it = parse(bs); return { id: num(it, 1), count: num(it, 2) }; });
  return { get: rd(2), cost: rd(3) };
}

// ==================== CDP 调用（单连接复用） ====================
const PORT = process.env.CDP_PORT || 62000;
const CTX = Number(process.env.CDP_CTX || 3);

let _conn = null;

async function cdpConnect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', () => j(new Error('CDP 连接失败：请确认 127.0.0.1:' + PORT + ' 可访问')));
    setTimeout(() => j(new Error('CDP 连接超时')), 8000);
  });
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 30000);
  });
  await send('Runtime.enable');
  return { ws, send };
}

async function getConn() {
  if (_conn && _conn.ws.readyState === 1) return _conn;
  _conn = await cdpConnect();
  return _conn;
}

export function closeConn() {
  try { if (_conn) _conn.ws.close(); } catch (e) { }
  _conn = null;
}

export async function botCall(service, method, bodyBuf) {
  const { send } = await getConn();
  const hasBot = await send('Runtime.evaluate', { expression: 'typeof globalThis.__bot === "object" && !!globalThis.__bot', contextId: CTX, returnByValue: true });
  if (!hasBot.result?.value) {
    const inj = readFileSync(new URL('./probe/inject_bot.js', import.meta.url), 'utf8');
    await send('Runtime.evaluate', { expression: inj, contextId: CTX, returnByValue: true });
  }
  const hex = bodyBuf ? Buffer.from(bodyBuf).toString('hex') : '';
  const expr = `globalThis.__bot.call(${JSON.stringify(service)},${JSON.stringify(method)},${JSON.stringify(hex)}).then(r=>JSON.stringify(r))`;
  const r = await send('Runtime.evaluate', { expression: expr, contextId: CTX, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  const o = JSON.parse(r.result.value);
  return { ...o, body: o.bodyHex ? Buffer.from(o.bodyHex, 'hex') : null };
}

// ==================== CLI ====================
const isMain = process.argv[1] && process.argv[1].endsWith('farm.mjs');
if (isMain) {
  const cmd = process.argv[2] || 'state';
  if (cmd === 'state') {
    let body;
    if (process.argv[3]) {
      body = readFileSync(process.argv[3]);
      console.log('[src] local file', process.argv[3]);
    } else {
      const hostGid = Number(process.argv[3] || 0);
      const r = await botCall('gamepb.plantpb.PlantService', 'AllLands', Buffer.alloc(0));
      if (!r.ok) { console.log('[fail]', r.err); process.exit(1); }
      body = r.body;
      console.log('[net] AllLands ok, len =', body.length);
    }
    const d = decodeAllLandsReply(body);
    console.log(`\n=== 土地 ${d.lands.length} 块 ===`);
    const ripe = [], empty = [];
    for (const l of d.lands) {
      const p = l.plant;
      let tag = '';
      if (!l.unlocked) tag = '未解锁';
      else if (!p || !p.id) { tag = '★空地'; empty.push(l.id); }
      else if (p.isRipe) { tag = '★成熟'; ripe.push(l.id); }
      else tag = PHASE[p.lastPhase] || '?';
      const extra = p && p.id ? `${p.name}(id=${p.id}) 草${p.weedOwners.length} 虫${p.insectOwners.length} 果${p.leftFruitNum}` : '';
      console.log(`  地${String(l.id).padStart(3)} lv${l.level} ${tag.padEnd(12)} ${extra}`);
    }
    console.log('\n成熟:', ripe.length ? ripe.join(',') : '无');
    console.log('空地:', empty.length ? empty.join(',') : '无');
    console.log('操作限制:', d.limits.map(l => `id${l.id}:${l.dayTimes}/${l.dayLimit}`).join(' '));
  } else if (cmd === 'probe') {
    const buf = Buffer.from(process.argv[3], 'hex');
    console.log(JSON.stringify(parse(buf).map(f => ({ no: f.no, wire: f.wire, len: f.wire === 2 ? f.v.length : undefined, hex: (f.wire === 2 ? f.v.subarray(0, 40) : Buffer.from([f.v])).toString('hex') })), null, 1));
  }
  closeConn();
  process.exit(0);
}
