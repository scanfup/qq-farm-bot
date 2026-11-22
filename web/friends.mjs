import {
  parse, fields, num, str, readVarint, repeatedInts,
  decodeLandInfo, decodeFarmingReply,
  buildVisitEnter, buildVisitLeave, buildHarvest, buildPutItem, buildFarming,
  encCat, wMsg, wVarint, wBytes, wPackedInts,
} from '../tools/farm.mjs';

const SVC = {
  friend: 'gamepb.friendpb.FriendService',
  visit: 'gamepb.visitpb.VisitService',
  plant: 'gamepb.plantpb.PlantService',
};
const TYPES = new Set(['friend-visit', 'friend-steal', 'friend-care', 'friend-insect', 'friend-weed']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const timestamp = () => new Date().toISOString();
const safeMessage = value => String(value || '未知错误').replace(/(?:wss?|https?):\/\/[^\s"'<>]+/g, '[地址已隐藏]').replace(/\b(?:token|openid|authorization)\s*[:=]\s*[^\s,;]+/gi, '[凭据已隐藏]').slice(0, 600);
const businessCode = error => {
  if (error?.uncertain || error?.cleanupFailed) return 0;
  const value = error?.code ?? error?.gateway?.meta?.err;
  // Transport error strings (ECONNRESET etc.) are NOT business rejections.
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const bodyOf = (reply, label) => {
  if (!reply || !Buffer.isBuffer(reply.body) || !reply.body.length) throw new Error(`${label}：空回包或缺失 protobuf body，停止操作`);
  return reply.body;
};
// farm.packedInts intentionally tolerates truncation. Before using its decoded owners,
// validate those particular packed fields strictly so malformed data cannot trigger a write.
function validatePacked(list, numbers) {
  for (const field of list) if (numbers.includes(field.no)) {
    if (field.wire === 2) {
      let offset = 0;
      while (offset < field.v.length) { const [, next] = readVarint(field.v, offset); offset = next; }
    } else if (field.wire !== 0) throw new Error('重复整数 protobuf 字段类型错误');
  }
}
function decodeVisit(reply) {
  const raw = parse(bodyOf(reply, '访问好友'));
  return fields(raw, 2).map(bytes => {
    if (!Buffer.isBuffer(bytes)) throw new Error('好友土地 protobuf 字段类型错误');
    const land = parse(bytes);
    validatePacked(land, [14]);
    for (const plant of fields(land, 10)) validatePacked(parse(plant), [12, 13, 14]);
    const decoded = decodeLandInfo(bytes);
    if (!positive(decoded.id)) throw new Error('好友土地 ID 无效');
    return decoded;
  });
}
const viable = land => land.unlocked && land.masterLandId === 0 && positive(land.plant?.id) && Number.isInteger(land.plant.currentPhase) && land.plant.currentPhase >= 1 && land.plant.currentPhase <= 6;
const growFirst = (a, b) => Number(a.plant.currentPhase === 6) - Number(b.plant.currentPhase === 6);

/** Friend protocol adapter. The caller serializes access to the shared bridge and wraps
 * each write RPC with its own ambiguity/journal guard (e.g. a bridge.call proxy).
 * No RPC is retried here, and no self-farm RPC is issued by this module. */
export class FriendsService {
  constructor({ bridge, log = () => {}, demo = false, selfGid = 0, identityProvider } = {}) {
    if (selfGid !== 0 && !positive(selfGid)) throw new Error('selfGid 必须为安全正整数或 0');
    if (!demo && typeof bridge?.call !== 'function') throw new Error('需要可用的 bridge.call');
    if (identityProvider !== undefined && typeof identityProvider !== 'function') throw new Error('identityProvider 必须为函数');
    this.bridge = bridge; this.log = log; this.demo = demo; this.identityProvider = identityProvider;
    this.explicitSelfGid = selfGid; this.selfGid = selfGid; this.identitySource = null;
    this.status = 'not-loaded'; this.fetchedAt = null; this.error = null;
    this.account = null; this.friends = []; this.preview = null; this.quota = null;
    this._identityKnown = false; this._running = false; this.activeGid = 0;
    const configured = Number(process.env.MAX_PER_FRIEND || 6);
    this.maxPerFriend = positive(configured) ? configured : 6;
    this._pause = ms => demo ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
    if (demo) this._initDemo();
  }
  state() {
    return structuredClone({ status: this.status, fetchedAt: this.fetchedAt, error: this.error,
      selfGid: this.selfGid, identitySource: this.identitySource, account: this.account, friends: this.friends,
      preview: this.preview, quota: this.quota });
  }
  _log(message) { this.log(safeMessage(message)); }
  updateLimits(limits) {
    if (!Array.isArray(limits)) throw new Error('操作额度必须为数组');
    const limit = limits.find(item => item.id === 10003);
    if (!limit) { this.quota = null; return; }
    if (![limit.dayTimes, limit.dayLimit].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('10003 额度数据无效');
    this.quota = { dayTimes: limit.dayTimes, dayLimit: limit.dayLimit, remaining: Math.max(0, limit.dayLimit - limit.dayTimes) };
  }
  invalidate() {
    this.status = 'not-loaded'; this.fetchedAt = null; this.error = null;
    this.selfGid = this.explicitSelfGid; this._identityKnown = false; this.identitySource = null;
    this.account = null; this.friends = []; this.preview = null; this.quota = null;
    // activeGid deliberately survives attachment changes until Leave is confirmed.
  }
  async refresh() {
    const previousSelfGid = this.selfGid;
    try {
      const reply = await this._rpc(SVC.friend, 'GetAll', Buffer.alloc(0));
      const records = fields(parse(bodyOf(reply, '好友列表')), 1);
      const friends = records.map(bytes => {
        const record = parse(bytes); const summary = fields(record, 9)[0];
        const detail = summary === undefined ? [] : parse(summary);
        const gid = num(record, 1);
        if (!positive(gid)) throw new Error('好友列表包含无效 gid');
        return { gid, name: str(record, 3), level: num(record, 6), hasSummary: summary !== undefined,
          stealable: num(detail, 6), weed: num(detail, 8), insect: num(detail, 9), isSelf: false };
      });
      if (new Set(friends.map(friend => friend.gid)).size !== friends.length) throw new Error('好友列表 gid 重复，无法安全识别身份');
      let runtimeIdentity;
      // The provider must read independent login data, never heartbeat/visited player IDs.
      // Read it afresh on every refresh, and never call it in demo mode.
      if (!this.demo && this.identityProvider) {
        try { runtimeIdentity = await this.identityProvider(); }
        catch (error) { this._log('登录身份资料暂不可用，使用保守身份校验：' + safeMessage(error.message)); }
      }
      const without = friends.filter(friend => !friend.hasSummary);
      if (positive(runtimeIdentity?.gid)) {
        if (!friends.some(friend => friend.gid === runtimeIdentity.gid)) throw new Error('游戏当前登录资料与好友列表身份不一致，拒绝操作并要求重新刷新');
        this.selfGid = runtimeIdentity.gid; this._identityKnown = true;
        this.identitySource = '游戏当前登录资料';
      } else {
        this._identityKnown = without.length === 1 || (without.length === 0 && positive(this.explicitSelfGid));
        this.selfGid = without.length === 1 ? without[0].gid : this.explicitSelfGid;
        this.identitySource = without.length === 1 ? '好友列表唯一无摘要条目' : this._identityKnown ? '显式自身 GID' : null;
      }
      if (this.selfGid !== previousSelfGid || !this._identityKnown) this.preview = null;
      for (const friend of friends) friend.isSelf = friend.gid === this.selfGid;
      const me = friends.find(friend => friend.isSelf);
      this.account = me ? { gid: me.gid, name: typeof runtimeIdentity?.name === 'string' && positive(runtimeIdentity?.gid) ? runtimeIdentity.name : me.name,
        level: Number.isSafeInteger(runtimeIdentity?.level) && positive(runtimeIdentity?.gid) ? runtimeIdentity.level : me.level } : null;
      this.friends = friends; this.status = 'ready'; this.fetchedAt = timestamp(); this.error = null;
      this._log(`好友列表已刷新：${friends.filter(friend => friend.hasSummary && !friend.isSelf).length} 位；${this._identityKnown ? `自身 GID ${this.selfGid}` : '身份存在歧义，禁止好友写操作'}`);
      return this.state();
    } catch (error) {
      this.status = 'error'; this.error = safeMessage(error.message); this.fetchedAt = null;
      this.friends = []; this.account = null; this.preview = null; this._identityKnown = false;
      this.selfGid = this.explicitSelfGid; this.identitySource = null;
      throw error;
    }
  }
  async _rpc(service, method, body, timeoutMs = 15000) {
    return this.demo ? this._demoRpc(service, method, body) : this.bridge.call(service, method, body, timeoutMs);
  }
  async ensureHome() {
    if (!this.activeGid) return;
    const gid = this.activeGid;
    try {
      await this._rpc(SVC.visit, 'Leave', buildVisitLeave(gid));
      this.activeGid = 0;
    } catch (cause) {
      const error = new Error(`离开好友 (${gid}) 失败：${safeMessage(cause.message)}；访客状态未确认，已停止所有后续操作`, { cause });
      error.cleanupFailed = true; error.visitGid = gid;
      if (cause.uncertain) error.uncertain = true;
      this.status = 'error'; this.error = safeMessage(error.message); this.preview = null;
      throw error;
    }
  }
  async _visit(friend, action) {
    let operationError;
    this.activeGid = friend.gid;
    try {
      // Leave is always attempted, even if Enter was rejected/timed out/empty.
      const reply = await this._rpc(SVC.visit, 'Enter', buildVisitEnter(friend.gid));
      return await action(decodeVisit(reply));
    } catch (error) { operationError = error; throw error; }
    finally {
      try { await this.ensureHome(); }
      catch (error) {
        if (operationError) {
          error.operationError = operationError;
          error.message += `；原操作错误：${safeMessage(operationError.message)}`;
          if (operationError.uncertain) error.uncertain = true;
        }
        throw error; // Deliberately no business code: cleanup failure is always terminal.
      }
    }
  }
  _record(result, friend, error, extra = {}) {
    const code = businessCode(error);
    if (!code || error.cleanupFailed) throw error;
    const item = { gid: friend.gid, name: friend.name, code, message: safeMessage(error.message), ...extra };
    result.errors.push(item); this._log(`${friend.name} [${code}] ${item.message}`);
    return code;
  }
  async run(type, gid) {
    if (!TYPES.has(type)) throw new Error('不支持的好友操作');
    const specified = gid !== undefined;
    if (specified && !positive(gid)) throw new Error('好友 gid 必须为安全正整数');
    if (!specified && !['friend-steal', 'friend-care'].includes(type)) throw new Error('访问、放虫、放草必须指定好友 gid');
    if (this._running) throw new Error('好友操作正在执行，请串行调用');
    this._running = true;
    const result = { count: 0, scanned: 0, attempted: 0, attemptedWrites: 0, changed: false, rounds: 0, rewardTotal: 0, rewards: [], errors: [], message: '' };
    try {
      await this.ensureHome();
      await this.refresh(); // Never act on a cached list after an unsuccessful refresh.
      if (type !== 'friend-visit' && !this._identityKnown) throw new Error('无法唯一确认自身账号，拒绝好友写操作；请核对好友列表与显式 selfGid');
      let targets = this.friends.filter(friend => friend.hasSummary && !friend.isSelf && friend.gid !== this.selfGid);
      if (specified) targets = targets.filter(friend => friend.gid === gid);
      if (specified && !targets.length) throw new Error('目标不是当前列表中具有农场摘要的其他好友，拒绝操作');
      if (type === 'friend-steal') targets = targets.filter(friend => friend.stealable > 0);
      if (type === 'friend-visit') {
        const friend = targets[0]; result.scanned++;
        const preview = await this._visit(friend, async lands => ({ gid: friend.gid, name: friend.name, lands, fetchedAt: timestamp() }));
        this.preview = preview; result.preview = structuredClone(preview);
        result.message = `已查看 ${friend.name} 的 ${preview.lands.length} 块土地并离开，未执行写操作`;
        return result;
      }
      const placement = type === 'friend-insect' || type === 'friend-weed';
      let perFriend = this.maxPerFriend;
      if (placement) {
        if (!this.quota) throw new Error('放虫/放草共享额度未知，请先用自家 AllLands 的 limits 调用 updateLimits');
        if (this.quota.remaining <= 0) { result.message = '今日放虫/放草共享额度已用尽（10003），未发送写请求'; return result; }
        perFriend = Math.max(1, Math.min(perFriend, Math.floor(this.quota.remaining / Math.max(1, targets.length))));
      }
      let stopped = false;
      for (const friend of targets) {
        result.scanned++;
        try {
          if (type === 'friend-care') await this._care(friend, result);
          else {
            await this._visit(friend, async lands => {
              const candidates = lands.filter(land => viable(land) && (type === 'friend-steal'
                ? land.plant.stealable && land.plant.leftFruitNum > 0 && land.plant.isRipe === true && !land.plant.stealers.includes(this.selfGid)
                : (type === 'friend-insect' ? land.plant.insectOwners : land.plant.weedOwners).length === 0)).sort(growFirst);
              const pick = placement ? candidates.slice(0, Math.min(perFriend, this.quota.remaining)) : candidates;
              if (!pick.length) return;
              if (!placement) {
                result.attempted += pick.length;
                result.attemptedWrites++;
                await this._rpc(SVC.plant, 'Harvest', buildHarvest(pick.map(land => land.id), friend.gid, true));
                result.changed = true; result.count += pick.length;
                this._log(`偷菜 ${friend.name}：游戏已确认 ${pick.length} 块`);
              } else {
                for (const land of pick) {
                  if (this.quota.remaining <= 0) { stopped = true; break; }
                  result.attempted++;
                  try {
                    result.attemptedWrites++;
                    await this._rpc(SVC.plant, type === 'friend-insect' ? 'PutInsects' : 'PutWeeds', buildPutItem(friend.gid, [land.id]));
                    result.changed = true; result.count++; this.quota.dayTimes++; this.quota.remaining = Math.max(0, this.quota.dayLimit - this.quota.dayTimes);
                  } catch (error) {
                    const code = this._record(result, friend, error, { landId: land.id });
                    if (code === 1001046) { this.quota.dayTimes = Math.max(this.quota.dayTimes, this.quota.dayLimit); this.quota.remaining = 0; stopped = true; break; }
                    if (code !== 1001036 && code !== 1001037) throw error;
                  }
                  await this._pause(120);
                }
                this._log(`${type === 'friend-insect' ? '放虫' : '放草'} ${friend.name}：已确认累计 ${result.count} 块`);
              }
            });
          }
        } catch (error) {
          // Already-recorded per-land business errors must not duplicate entries.
          if (!businessCode(error) || error.cleanupFailed) throw error;
          if (!result.errors.some(item => item.gid === friend.gid && item.code === businessCode(error) && item.message === safeMessage(error.message))) this._record(result, friend, error);
        }
        if (stopped) break;
        await this._pause(type === 'friend-care' ? 150 : 200);
      }
      result.stopped = stopped;
      result.message = `${type === 'friend-care' ? '好友务农' : type === 'friend-steal' ? '好友偷菜' : type === 'friend-insect' ? '好友放虫' : '好友放草'}完成：确认 ${result.count} 项，扫描 ${result.scanned} 位好友${result.errors.length ? `；${result.errors.length} 条明确业务拒绝（部分结果）` : ''}${stopped ? '；共享额度耗尽，已停止' : ''}`;
      return result;
    } catch (error) {
      // Do not convert transport/decode/context failures into a successful partial result.
      error.partialResult = structuredClone(result);
      this.error = safeMessage(error.message); this.status = 'error'; this.preview = null;
      throw error;
    } finally { this._running = false; }
  }
  async _care(friend, result) {
    for (let round = 1; round <= 3; round++) {
      let converged = false;
      await this._visit(friend, async lands => {
        result.rounds++;
        const candidates = lands.filter(land => viable(land) && (land.plant.needCare || land.plant.weedOwners.length || land.plant.insectOwners.length));
        if (!candidates.length) { converged = true; return; }
        result.attempted += candidates.length;
        let reply;
        result.attemptedWrites++;
        try { reply = await this._rpc(SVC.plant, 'Farming', buildFarming(candidates.map(land => land.id), friend.gid, true), 25000); }
        catch (error) {
          if (businessCode(error) === 1001057) { converged = true; this._log(`务农 ${friend.name} 第 ${round} 轮：服务端确认无需继续处理`); return; }
          throw error;
        }
        result.changed = true;
        const decoded = decodeFarmingReply(bodyOf(reply, '好友务农'));
        result.count += decoded.results.length;
        for (const item of decoded.results) if (item.reward) { result.rewardTotal += item.reward.count || 0; result.rewards.push({ gid: friend.gid, landId: item.landId, ...item.reward }); }
        if (decoded.limits.some(item => item.id === 10003)) this.updateLimits(decoded.limits);
        this._log(`务农 ${friend.name} 第 ${round} 轮：游戏确认 ${decoded.results.length}/${candidates.length} 条`);
      });
      if (converged || round === 3) break;
      await this._pause(300);
    }
  }

  _initDemo() {
    const self = this.explicitSelfGid || 900001;
    this._demoFriends = [
      { gid: self, name: '演示农场主', level: 20, hasSummary: false },
      { gid: self === 900002 ? 900003 : 900002, name: '演示好友', level: 18, hasSummary: true, stealable: 2, weed: 1, insect: 0 },
    ];
    const friend = this._demoFriends[1].gid;
    const plant = (id, phase, care = false) => encCat(wVarint(1, 1020002), wBytes(2, Buffer.from('白萝卜')), wMsg(4, encCat(wVarint(1, phase), wVarint(2, 1), ...(care ? [wVarint(7, 1)] : []))), wVarint(16, 1), wVarint(18, 5));
    this._demoLands = new Map([[friend, [1, 2].map(id => encCat(wVarint(1, id), wVarint(2, 1), wVarint(3, 1), wMsg(10, plant(id, id === 1 ? 2 : 6, id === 1))))]]);
    this.updateLimits([{ id: 10003, dayTimes: 0, dayLimit: 100 }]);
  }
  async _demoRpc(service, method, body) {
    const request = parse(body);
    if (service === SVC.friend && method === 'GetAll') return { body: encCat(...this._demoFriends.map(friend => wMsg(1, encCat(wVarint(1, friend.gid), wBytes(3, Buffer.from(friend.name)), wVarint(6, friend.level), ...(friend.hasSummary ? [wMsg(9, encCat(wVarint(6, friend.stealable), wVarint(8, friend.weed), wVarint(9, friend.insect)))] : []))))) };
    if (service === SVC.visit && method === 'Leave') return { body: Buffer.alloc(0) };
    if (service === SVC.visit && method === 'Enter') return { body: encCat(...(this._demoLands.get(num(request, 1)) || []).map(bytes => wMsg(2, bytes))) };
    const gid = num(request, method === 'PutInsects' || method === 'PutWeeds' ? 1 : 2);
    const ids = repeatedInts(request, method === 'PutInsects' || method === 'PutWeeds' ? 2 : 1);
    if (!this._demoLands.has(gid)) throw new Error('演示目标不存在');
    if (method === 'Farming') {
      this._demoLands.set(gid, this._demoLands.get(gid).map(bytes => {
        if (!ids.includes(num(parse(bytes), 1))) return bytes;
        return encCat(wVarint(1, num(parse(bytes), 1)), wVarint(2, 1), wMsg(10, encCat(wVarint(1, 1020002), wMsg(4, encCat(wVarint(1, 2), wVarint(2, 1))), wVarint(16, 1), wVarint(18, 5))));
      }));
      return { body: encCat(...ids.map(id => wMsg(3, encCat(wVarint(1, id), wMsg(2, encCat(wVarint(1, 1101), wVarint(2, 1))))))) };
    }
    this._demoLands.set(gid, this._demoLands.get(gid).map(bytes => {
      const land = parse(bytes); if (!ids.includes(num(land, 1))) return bytes;
      const plant = parse(fields(land, 10)[0]);
      const remove = method === 'Harvest' ? 18 : method === 'PutInsects' ? 13 : 12;
      const keep = plant.filter(field => field.no !== remove).map(field => field.wire === 2 ? wBytes(field.no, field.v) : wVarint(field.no, field.v));
      return encCat(wVarint(1, num(land, 1)), wVarint(2, 1), wMsg(10, encCat(...keep, method === 'Harvest' ? wVarint(18, 0) : wPackedInts(remove, [this.selfGid]))));
    }));
    if (method === 'Harvest') this._demoFriends.find(friend => friend.gid === gid).stealable = 0;
    return { body: Buffer.alloc(0) };
  }
}
