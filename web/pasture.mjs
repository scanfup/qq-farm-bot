const PASTURE = {
  animal: 'gamepb.animalpb.AnimalService', ranch: 'gamepb.animalpb.RanchService',
  shop: 'gamepb.shoppb.ShopService', item: 'gamepb.itempb.ItemService',
  friend: 'gamepb.friendpb.FriendService', home: 'gamepb.homesteadpb.HomesteadService',
  feedMachine: 'gamepb.homesteadpb.FeedMachineService',
};
export const PASTURE_READ_COMMANDS = ['pasture-refresh', 'pasture-visit'];
export const PASTURE_COMMANDS = ['pasture-harvest', 'pasture-produce', 'pasture-clean', 'pasture-place', 'pasture-feed', 'pasture-buy', 'pasture-friends-clean', 'pasture-friends-steal'];
const READ = new Set(['GetRanchDetail', 'GetRanchOpTimes', 'GetBag', 'Bag', 'GetAll', 'ShopProfiles', 'ShopInfo', 'AllCells']);
const arr = value => Array.isArray(value) ? value : [];
const clone = value => structuredClone(value);
const int = value => typeof value === 'string' && /^\d+$/.test(value)
  ? BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value : value;
const positive = value => Number.isSafeInteger(value) && value > 0 || typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n;
const safeCount = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const stamp = () => new Date().toISOString();
const message = error => String(error?.message || error || '未知错误').slice(0, 600);
const ranches = reply => arr(reply?.ranches || reply?.data?.ranches);
const countOf = (inventory, id) => inventory.find(item => String(item.id) === String(id))?.count || 0;
const targetKey = target => `${target.ranch_inst_id}:${target.animal_inst_id ?? target.slot_index}`;
const uncertainty = text => Object.assign(new Error(text), { uncertain: true });
const resultTemplate = () => ({ count: 0, attemptedWrites: 0, changed: false, spent: 0, errors: [], message: '', scanned: 0, skipped: 0, confirmedFriends: 0 });
function business(error) {
  if (error?.uncertain || error?.cleanupFailed) return 0;
  const raw = error?.code ?? error?.error_code;
  const code = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(code) && code > 0 ? code : error?.operationFailure ? -1 : 0;
}
function inventoryRows(reply) {
  const totals = new Map();
  const rows = [...arr(reply?.physical_items), ...arr(reply?.virtual_items), ...arr(reply?.item_bag?.items), ...arr(reply?.items)];
  for (const row of rows) {
    const id = int(row.id ?? row.item_id), count = Number(row.count ?? row.num ?? row.amount ?? 0);
    if (!positive(id) || !Number.isSafeInteger(count) || count < 0) throw new Error('牧场背包物品数量或ID无效');
    const sum = (totals.get(String(id)) || 0) + count;
    if (!Number.isSafeInteger(sum)) throw new Error('牧场背包堆叠数量超出安全范围');
    totals.set(String(id), sum);
  }
  return [...totals].map(([id, count]) => ({ id: int(id), count }));
}
function friendRows(reply, selfGid) {
  return arr(reply?.game_friends || reply?.friends).map(friend => ({
    gid: int(friend.gid), name: String(friend.name || ''), hostType: int(friend.host_type ?? 0),
    isSelf: String(friend.gid) === String(selfGid), bigFarmStatus: friend.big_farm_status || null,
  })).filter(friend => positive(friend.gid));
}
function feedMachines(reply) {
  // Only explicit ownership and the active facility state permit inventory writes.
  return arr(reply?.facilities).filter(facility => Number(facility.module_type) === 8).map(facility => ({
    instanceId: int(facility.instance_id), capacity: Number(facility.capacity),
    feedCount: Number(facility.feed_machine?.feed_count ?? 0),
    isOwner: facility.feed_machine?.is_owner === true,
    status: int(facility.state),
  })).filter(machine => positive(machine.instanceId));
}
function animalRefs(rows) {
  return rows.flatMap(ranch => arr(ranch.animals).filter(animal => animal.can_harvest === true).map(animal => ({
    ranch_inst_id: int(ranch.ranch_inst_id), animal_inst_id: int(animal.animal_inst_id),
  }))).filter(ref => positive(ref.ranch_inst_id) && positive(ref.animal_inst_id));
}
function shelfRefs(rows, steal = false) {
  return rows.flatMap(ranch => arr(ranch.shelves).filter(shelf => steal
    ? shelf.can_steal === true && arr(shelf.lots).some(lot => lot.can_steal === true && Number(lot.remain_num ?? 0) > 0)
    : shelf.can_collect === true).map(shelf => ({ ranch_inst_id: int(ranch.ranch_inst_id), slot_index: int(shelf.slot_index) })))
    .filter(ref => positive(ref.ranch_inst_id) && positive(ref.slot_index));
}
function animalMap(rows) {
  return new Map(rows.flatMap(ranch => arr(ranch.animals).map(animal => [targetKey({ ranch_inst_id: ranch.ranch_inst_id, animal_inst_id: animal.animal_inst_id }), animal])));
}
function shelfMap(rows) {
  return new Map(rows.flatMap(ranch => arr(ranch.shelves).map(shelf => [targetKey({ ranch_inst_id: ranch.ranch_inst_id, slot_index: shelf.slot_index }), shelf])));
}
function shelfQuantity(shelf) {
  if (!shelf) return 0;
  if (safeCount(shelf.total_remain)) return Number(shelf.total_remain);
  return arr(shelf.lots).reduce((total, lot) => total + Number(lot.remain_num || 0), 0);
}
function hazardIds(rows) {
  return [...new Map(rows.flatMap(ranch => arr(ranch.hazards).map(hazard => int(hazard.hazard_id ?? hazard.id)))
    .filter(positive).map(id => [String(id), id])).values()];
}
function operationResults(reply) {
  return arr(reply?.op_results || reply?.opResults || (reply?.op_result ? [reply.op_result] : []));
}
function operationFailures(reply) {
  return operationResults(reply).flatMap((operation, index) => {
    const code = Number(operation.error_code ?? operation.code ?? operation.err_code ?? 0);
    if (code > 0) return [{ index, code, targetId: operation.target_id, message: operation.error_msg || `牧场单项操作失败(${code})` }];
    if (operation.success === false || operation.ok === false) return [{ index, code: 0, targetId: operation.target_id, message: '牧场单项操作返回失败' }];
    return [];
  });
}
function limitOf(payload, fallback = Infinity) {
  if (payload.limit === undefined) return fallback;
  if (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 100) throw new Error('批量上限必须为1至100');
  return payload.limit;
}

export class PastureService {
  constructor({ rpc, metadataProvider, identityProvider, preferencesProvider, log = () => {}, demo = false } = {}) {
    if (!demo && typeof rpc !== 'function') throw new Error('需要rpc函数');
    this.rpc = rpc; this.metadataProvider = metadataProvider; this.identityProvider = identityProvider;
    this.preferencesProvider = preferencesProvider || (() => ({})); this.log = log; this.demo = demo;
    this.metadata = { animals: [], items: [], goods: [] }; this.shopGoods = []; this._running = false;
    this.invalidate();
    if (demo) this._demoInit();
  }
  state() {
    return clone({ status: this.status, error: this.error, fetchedAt: this.fetchedAt,
      selfGid: this.selfGid, account: this.account, ranches: this.ranches, animals: this.animals,
      inventoryStatus: this.inventoryStatus, feedMachines: this.feedMachines,
      balances: { 1007: countOf(this.inventory, 1007), 1008: countOf(this.inventory, 1008) },
      grassStock: countOf(this.inventory, 7001),
      friends: this.friends, quota: this.quota, preview: this.preview });
  }
  invalidate() {
    this.status = 'not-loaded'; this.error = null; this.fetchedAt = null; this.selfGid = 0; this.account = null;
    this.ranches = []; this.animals = []; this.inventory = []; this.inventoryStatus = 'not-loaded';
    this.feedMachines = []; this.friends = { status: 'not-loaded', error: null, fetchedAt: null, items: [] };
    this.quota = []; this.preview = null; this.shopGoods = [];
  }
  _failRefresh(error) {
    this.invalidate(); this.status = 'error'; this.error = message(error); this.inventoryStatus = 'error';
    this.friends = { status: 'error', error: message(error), fetchedAt: null, items: [] };
  }
  async _call(service, method, request = {}, write = false) {
    if (!write && !READ.has(method)) throw new Error(`牧场只读白名单不含${method}`);
    return this.demo ? this._demoRpc(service, method, request) : this.rpc(service, method, request, { write });
  }
  _syncAnimals() {
    const byAnimal = new Map();
    for (const animal of arr(this.metadata.animals)) {
      const animalId = int(animal.animalId ?? animal.id), itemId = int(animal.itemId ?? animal.cub_item_id);
      if (!positive(animalId) || !positive(itemId) || byAnimal.has(String(animalId))) continue;
      const goods = this.shopGoods.find(row => String(row.item_id) === String(itemId));
      const configured = arr(this.metadata.goods).find(row => String(row.id) === String(goods?.id));
      byAnimal.set(String(animalId), {
        animalId, itemId, name: animal.name || '', husbandryType: int(animal.husbandryType ?? animal.husbandry_type ?? 0),
        giantCubItemId: animal.giantCubItemId ?? animal.giant_cub_item_id,
        count: countOf(this.inventory, itemId), price: goods?.price, goodsId: int(goods?.id),
        priceId: int(configured?.price_id), unlocked: goods?.unlocked === true,
      });
    }
    this.animals = [...byAnimal.values()];
  }
  async refresh() {
    const oldGid = this.selfGid;
    try {
      const identity = this.demo ? this.account : await this.identityProvider?.();
      const gid = int(identity?.gid);
      if (!positive(gid)) throw new Error('当前牧场账号GID无效');
      if (String(oldGid) !== String(gid)) this.preview = null;
      this.selfGid = gid; this.account = { gid, name: identity.name || '', level: identity.level || 0 };
      if (!this.demo) this.metadata = await this.metadataProvider?.();
      if (!Array.isArray(this.metadata?.animals) || !this.metadata.animals.length) throw new Error('牧场动物配置尚未加载');
      const [detail, bag, friends, shop, quota, cells] = await Promise.all([
        this._detail(gid), this._bag(), this._call(PASTURE.friend, 'GetAll', { global_scene_id: 2 }),
        this._call(PASTURE.shop, 'ShopInfo', { shop_id: 5 }),
        this._call(PASTURE.ranch, 'GetRanchOpTimes', { op_ids: [11003, 11004, 11005, 11006, 11007, 11008, 11009] }),
        this._call(PASTURE.home, 'AllCells', {}),
      ]);
      this.ranches = clone(ranches(detail)); this.inventory = inventoryRows(bag); this.inventoryStatus = 'ready';
      this.feedMachines = feedMachines(cells); this.shopGoods = clone(arr(shop?.goods_list || shop?.goods));
      this._syncAnimals();
      this.friends = { status: 'ready', error: null, fetchedAt: stamp(), items: friendRows(friends, gid) };
      this.quota = clone(arr(quota?.ops || quota?.quota)); this.status = 'ready'; this.error = null; this.fetchedAt = stamp();
      return this.state();
    } catch (error) { this._failRefresh(error); throw error; }
  }
  async _detail(gid) { return this._call(PASTURE.animal, 'GetRanchDetail', { host_gid: gid, ranch_inst_ids: [] }); }
  async _bag() { return this._call(PASTURE.item, 'GetBag', { global_scene_id: 2, tab_id: 0 }); }
  async _refreshOwnResources() {
    try {
      const [detail, bag] = await Promise.all([this._detail(this.selfGid), this._bag()]);
      this.ranches = clone(ranches(detail)); this.inventory = inventoryRows(bag); this.inventoryStatus = 'ready';
      this._syncAnimals(); return { ranches: clone(this.ranches), inventory: clone(this.inventory) };
    } catch (error) { this._failRefresh(error); throw error; }
  }
  async _refreshShop() {
    try {
      const reply = await this._call(PASTURE.shop, 'ShopInfo', { shop_id: 5 });
      this.shopGoods = clone(arr(reply?.goods_list || reply?.goods)); this._syncAnimals();
    } catch (error) { this._failRefresh(error); throw error; }
  }
  _assertReady() { if (this.status !== 'ready') throw new Error('请先刷新牧场'); }
  async run(type, payload = {}) {
    if (![...PASTURE_READ_COMMANDS, ...PASTURE_COMMANDS].includes(type)) throw new Error('不支持的牧场操作');
    if (this._running) throw new Error('牧场操作正在执行，请串行调用');
    this._running = true; const result = resultTemplate();
    try {
      if (type === 'pasture-refresh') { await this.refresh(); result.message = '牧场刷新完成'; return result; }
      this._assertReady();
      if (type === 'pasture-visit') {
        const gid = int(payload.gid);
        if (!positive(gid)) throw new Error('牧场目标GID无效');
        const detail = await this._detail(gid);
        const friend = this.friends.items.find(item => String(item.gid) === String(gid));
        this.preview = { gid, name: friend?.name || (String(gid) === String(this.selfGid) ? this.account?.name : '') || '', ranches: clone(ranches(detail)), fetchedAt: stamp() };
        return { ...result, preview: { gid, name: this.preview.name, ranchCount: this.preview.ranches.length }, message: '牧场预览完成（仅查询，未进入访问场景）' };
      }
      const methods = { 'pasture-buy': '_buy', 'pasture-place': '_place', 'pasture-feed': '_feed',
        'pasture-harvest': '_harvest', 'pasture-produce': '_produce', 'pasture-clean': '_cleanSelf',
        'pasture-friends-clean': '_friendsClean', 'pasture-friends-steal': '_friendsSteal' };
      return await this[methods[type]](payload, result);
    } catch (error) {
      if (type === 'pasture-visit') this.preview = null;
      error.partialResult = clone(result); throw error;
    } finally { this._running = false; }
  }
  async _write(service, method, request, result) {
    result.attemptedWrites++;
    let reply;
    try { reply = await this._call(service, method, request, true); }
    catch (error) { if (!business(error)) error.uncertain = true; throw error; }
    const failures = operationFailures(reply);
    if (failures.length) {
      result.errors.push(...failures.map(failure => ({ ...failure, operation: method })));
      throw Object.assign(new Error('牧场存在单项业务失败'), { code: failures[0].code || undefined, operationFailure: true });
    }
    return reply;
  }
  async _verifyAfterWrite(callback) {
    try { return await callback(); }
    catch (error) { error.uncertain = true; throw error; }
  }
  async _finish(result, text) {
    result.message = text;
    if (result.attemptedWrites) await this._verifyAfterWrite(() => this.refresh());
    return result;
  }
  _buyPolicy() {
    const preferences = this.preferencesProvider() || {};
    const budget = preferences.maxAnimalSpendPerCycle;
    if (preferences.allowAnimalPurchase !== true || !Number.isSafeInteger(budget) || budget <= 0 || budget > 1000000) return { allowed: false, budget: 0 };
    return { allowed: true, budget };
  }
  async _buyOne(animalId, result, budget, expectedUnitPrice) {
    await this._refreshOwnResources(); await this._refreshShop();
    const animal = this.animals.find(item => String(item.animalId) === String(animalId));
    if (!animal || !animal.unlocked || !positive(animal.goodsId)) return false;
    const price = Number(animal.price), currencyId = animal.priceId;
    if (!Number.isSafeInteger(price) || price < 0 || !positive(currencyId)) throw Object.assign(new Error('商品实时价格或币种无效，停止购买'), { operationFailure: true });
    if (expectedUnitPrice !== undefined && price !== expectedUnitPrice) throw Object.assign(new Error('动物单价已变化，请刷新并确认新总价；未继续购买'), { operationFailure: true });
    if (result.spent + price > budget || countOf(this.inventory, currencyId) < price) return false;
    const beforeItem = countOf(this.inventory, animal.itemId), beforeMoney = countOf(this.inventory, currencyId);
    await this._write(PASTURE.shop, 'BuyGoods', { goods_id: animal.goodsId, num: 1, price, auto_add: false }, result);
    const after = await this._verifyAfterWrite(() => this._refreshOwnResources());
    if (countOf(after.inventory, animal.itemId) - beforeItem !== 1 || beforeMoney - countOf(after.inventory, currencyId) !== price) {
      throw uncertainty('购买已返回，但幼崽库存增量或余额扣除未核对一致；停止且不自动入栏/重购');
    }
    result.spent += price; result.changed = true;
    return true;
  }
  async _buy(payload, result) {
    const count = payload.count ?? 1;
    if (!positive(payload.animalId) || !Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('购买需要有效动物ID和1至20数量');
    if (payload.expectedUnitPrice !== undefined && (!Number.isSafeInteger(payload.expectedUnitPrice) || payload.expectedUnitPrice < 0)) throw new Error('展示单价必须为非负安全整数');
    // Explicit manual purchase is a separate authorization from automatic buying.
    await this._refreshOwnResources(); await this._refreshShop();
    const animal = this.animals.find(item => String(item.animalId) === String(payload.animalId));
    if (!animal?.unlocked || !positive(animal.goodsId)) throw Object.assign(new Error('指定动物不存在或尚未解锁'), { operationFailure: true });
    const initialPrice = Number(animal.price), budget = initialPrice * count;
    if (!Number.isSafeInteger(initialPrice) || initialPrice < 0 || !Number.isSafeInteger(budget) || !positive(animal.priceId)) throw new Error('商品价格或币种无效');
    if (payload.expectedUnitPrice !== undefined && initialPrice !== payload.expectedUnitPrice) throw Object.assign(new Error('动物单价已变化，请刷新确认新总价'), { operationFailure: true });
    if (countOf(this.inventory, animal.priceId) < budget) throw Object.assign(new Error('金券余额不足以完成本次全部购买，未购买'), { operationFailure: true });
    for (let index = 0; index < count; index++) {
      if (!await this._buyOne(payload.animalId, result, budget, payload.expectedUnitPrice)) break;
      result.count++;
    }
    return this._finish(result, `已核对购买 ${result.count}/${count} 只，实际花费 ${result.spent} 金券；单价、余额或本笔上限变化时停止`);
  }
  async _place(payload, result) {
    const preferences = this.preferencesProvider() || {}, policy = this._buyPolicy();
    const limit = limitOf(payload);
    await this._refreshOwnResources();
    const ids = [...new Set([...arr(preferences.animalPriority), ...(preferences.animalFallback === true ? this.animals.map(item => item.animalId) : [])].map(String))];
    for (const id of ids) {
      while (result.count < limit) {
        await this._refreshOwnResources();
        let animal = this.animals.find(item => String(item.animalId) === id);
        if (!animal || ![1, 2].includes(Number(animal.husbandryType))) break;
        const ranch = this.ranches.find(row => Number(row.husbandry_type) === Number(animal.husbandryType)
          && safeCount(row.capacity) && safeCount(row.animal_count ?? arr(row.animals).length)
          && Number(row.capacity) > Math.max(Number(row.animal_count ?? 0), arr(row.animals).length));
        if (!ranch) break;
        if (countOf(this.inventory, animal.itemId) < 1) {
          if (!policy.allowed || !await this._buyOne(animal.animalId, result, policy.budget)) break;
          // Buying may alter resources; never reuse the former capacity/stock snapshot.
          continue;
        }
        const beforeCount = Math.max(Number(ranch.animal_count ?? 0), arr(ranch.animals).length);
        const beforeStock = countOf(this.inventory, animal.itemId);
        const item = { ranch_inst_id: int(ranch.ranch_inst_id), animal_id: int(animal.animalId) };
        if (positive(animal.giantCubItemId)) item.giant_cub_item_id = int(animal.giantCubItemId);
        await this._write(PASTURE.animal, 'PlaceAnimal', { items: [item] }, result);
        const after = await this._verifyAfterWrite(() => this._refreshOwnResources());
        const updated = after.ranches.find(row => String(row.ranch_inst_id) === String(ranch.ranch_inst_id));
        const afterCount = updated ? Math.max(Number(updated.animal_count ?? 0), arr(updated.animals).length) : -1;
        if (afterCount !== beforeCount + 1 || afterCount > Number(ranch.capacity)
          || beforeStock - countOf(after.inventory, animal.itemId) !== 1) {
          throw uncertainty('入栏已返回，但栏舍动物增量和幼崽库存扣除未核对一致；停止且不重发');
        }
        result.count++; result.changed = true;
      }
      if (result.count >= limit) break;
    }
    return this._finish(result, `已核对入栏 ${result.count} 只动物，自动购买实际花费 ${result.spent}`);
  }
  async _feed(payload, result) {
    const limit = limitOf(payload);
    await this._refreshOwnResources();
    let cells = await this._call(PASTURE.home, 'AllCells', {});
    this.feedMachines = feedMachines(cells);
    const machineIds = this.feedMachines.map(machine => machine.instanceId);
    for (const id of machineIds) {
      if (result.count >= limit) break;
      await this._refreshOwnResources();
      cells = await this._call(PASTURE.home, 'AllCells', {}); this.feedMachines = feedMachines(cells);
      const machine = clone(this.feedMachines.find(item => String(item.instanceId) === String(id)));
      if (!machine || machine.isOwner !== true || machine.status !== 1 || !safeCount(machine.capacity)
        || machine.capacity <= 0 || !safeCount(machine.feedCount) || machine.feedCount > machine.capacity) continue;
      const stock = countOf(this.inventory, 7001), add = Math.min(machine.capacity - machine.feedCount, stock, limit - result.count);
      if (!Number.isSafeInteger(add) || add < 1) continue;
      await this._write(PASTURE.feedMachine, 'AddFeed', { instance_id: machine.instanceId, add_count: add, use_gold: false, host_gid: 0 }, result);
      const verified = await this._verifyAfterWrite(async () => {
        const own = await this._refreshOwnResources();
        const reply = await this._call(PASTURE.home, 'AllCells', {});
        this.feedMachines = feedMachines(reply);
        return { own, machine: this.feedMachines.find(item => String(item.instanceId) === String(id)) };
      });
      if (!verified.machine || verified.machine.feedCount - machine.feedCount !== add || stock - countOf(verified.own.inventory, 7001) !== add) {
        throw uncertainty('添加牧草已返回，但牧草机增量与库存扣除未核对一致');
      }
      result.count += add; result.changed = true;
    }
    return this._finish(result, result.count ? `已核对补充 ${result.count} 份库存牧草` : '没有明确归自己所有且已激活的可补充牧草机，或库存/容量不足；未购买');
  }
  async _produce(payload, result) {
    const before = clone(ranches(await this._detail(this.selfGid)));
    const limit = limitOf(payload);
    const refs = before.flatMap(ranch => arr(ranch.animals)
      .filter(animal => Number(animal.stage) === 3 && animal.can_deliver === true
        && animal.producing !== true && animal.grass_blocked !== true)
      .map(animal => ({ ranch_inst_id: int(ranch.ranch_inst_id), animal_inst_id: int(animal.animal_inst_id) })))
      .filter(ref => positive(ref.ranch_inst_id) && positive(ref.animal_inst_id)).slice(0, limit);
    if (!refs.length) { result.message = '没有符合接生条件的动物'; result.skipped = 1; return result; }
    await this._write(PASTURE.animal, 'TriggerProduce', { host_gid: 0, targets: refs }, result);
    const after = await this._verifyAfterWrite(() => this._refreshOwnResources());
    const afterAnimals = animalMap(after.ranches), beforeAnimals = animalMap(before);
    const changed = ref => {
      const old = beforeAnimals.get(targetKey(ref));
      const next = afterAnimals.get(targetKey(ref));
      if (!next) return false;
      const stateChanged = next.stage !== old?.stage || next.produce_count !== old?.produce_count
        || next.produce_ready_at_ms !== old?.produce_ready_at_ms
        || next.delivering_until_ms !== old?.delivering_until_ms;
      return next.producing === true || (next.can_deliver !== true && stateChanged);
    };
    result.count = refs.filter(changed).length;
    result.changed = result.count > 0;
    if (result.count !== refs.length) throw uncertainty(`接生已返回，仅核对 ${result.count}/${refs.length} 个动物状态变化；停止重试`);
    return this._finish(result, `已核对 ${result.count} 个动物进入生产`);
  }
  async _harvest(payload, result) {
    const before = clone(ranches(await this._detail(this.selfGid))), limit = limitOf(payload);
    const animals = animalRefs(before).slice(0, limit);
    const shelves = shelfRefs(before).slice(0, Math.max(0, limit - animals.length));
    if (!animals.length && !shelves.length) { result.message = '没有可收取的动物或货架产物'; return result; }
    const request = limit === Infinity
      ? { ranch_inst_ids: before.map(row => int(row.ranch_inst_id)), op: 1, animals: [], shelves: [] }
      : { ranch_inst_ids: [...new Set([...animals, ...shelves].map(ref => ref.ranch_inst_id))], op: 4, animals, shelves };
    await this._write(PASTURE.animal, 'HarvestRanch', request, result);
    const after = await this._verifyAfterWrite(() => this._refreshOwnResources());
    const afterAnimals = animalMap(after.ranches), afterShelves = shelfMap(after.ranches), beforeShelves = shelfMap(before);
    result.count = animals.filter(ref => !afterAnimals.has(targetKey(ref)) || afterAnimals.get(targetKey(ref)).can_harvest !== true).length
      + shelves.filter(ref => !afterShelves.has(targetKey(ref)) || shelfQuantity(afterShelves.get(targetKey(ref))) < shelfQuantity(beforeShelves.get(targetKey(ref)))).length;
    result.changed = result.count > 0;
    if (result.count !== animals.length + shelves.length) throw uncertainty(`收取已返回，仅核对 ${result.count}/${animals.length + shelves.length} 个目标变化；停止重试`);
    return this._finish(result, `已核对收取 ${result.count} 个动物/货架目标`);
  }
  async _cleanTarget(gid, payload, result) {
    const before = clone(ranches(await this._detail(gid))), ids = hazardIds(before).slice(0, limitOf(payload));
    if (!ids.length) return;
    await this._write(PASTURE.ranch, 'CleanRanch', { host_gid: gid, hazard_ids: ids }, result);
    const after = await this._verifyAfterWrite(() => this._detail(gid));
    const remaining = new Set(hazardIds(ranches(after)).map(String));
    const count = ids.filter(id => !remaining.has(String(id))).length;
    result.count += count; result.changed ||= count > 0;
    if (count !== ids.length) throw uncertainty(`清理已返回，仅核对 ${count}/${ids.length} 个危害消失`);
  }
  async _cleanSelf(payload, result) {
    await this._cleanTarget(this.selfGid, payload, result);
    return this._finish(result, `已核对自家清理 ${result.count} 项危害`);
  }
  _friendTargets(payload) {
    if (payload.gid !== undefined && !positive(int(payload.gid))) throw new Error('好友GID无效');
    if (payload.maxFriends !== undefined && (!Number.isSafeInteger(payload.maxFriends) || payload.maxFriends < 1 || payload.maxFriends > 100)) throw new Error('好友数量上限无效');
    const others = this.friends.items.filter(friend => !friend.isSelf && positive(friend.gid));
    if (payload.gid !== undefined) {
      const gid = String(int(payload.gid));
      const target = others.find(friend => String(friend.gid) === gid);
      if (!target) throw new Error('指定好友不在场景2好友列表中，拒绝执行');
      return [target];
    }
    return others.slice(0, payload.maxFriends ?? Infinity);
  }
  _friendError(error, friend, result) {
    const code = business(error);
    if (!code) throw error;
    result.errors.push({ gid: friend.gid, code, message: message(error) });
  }
  async _friendsClean(payload, result) {
    for (const friend of this._friendTargets(payload)) {
      result.scanned++;
      try {
        const before = result.count;
        await this._cleanTarget(friend.gid, payload, result);
        if (result.count === before) result.skipped++;
        else result.confirmedFriends++;
      } catch (error) { this._friendError(error, friend, result); }
    }
    // Always refresh scene-2 summaries after a friend batch, even if it skipped writes.
    if (result.attemptedWrites) await this._verifyAfterWrite(() => this.refresh());
    else await this.refresh();
    result.message = `好友牧场清理：扫描 ${result.scanned}，确认好友 ${result.confirmedFriends}，跳过 ${result.skipped}，已核对 ${result.count} 项${result.errors.length ? `，${result.errors.length} 项拒绝` : ''}`;
    return result;
  }
  _rewardMatchesShelf(operation, ref) {
    const facility = operation?.facility_inst_id ?? operation?.ranch_inst_id;
    const target = operation?.target_id ?? operation?.slot_index;
    return positive(facility) && positive(target)
      && String(facility) === String(ref.ranch_inst_id) && String(target) === String(ref.slot_index)
      && arr(operation?.rewards).some(reward => Number(reward.count || 0) > 0);
  }
  async _friendsSteal(payload, result) {
    for (const friend of this._friendTargets(payload)) {
      result.scanned++;
      try {
        const before = clone(ranches(await this._detail(friend.gid))), refs = shelfRefs(before, true).slice(0, limitOf(payload));
        if (!refs.length) { result.skipped++; continue; }
        const reply = await this._write(PASTURE.animal, 'StealProduce', { host_gid: friend.gid, targets: refs }, result);
        const after = await this._verifyAfterWrite(() => this._detail(friend.gid));
        const beforeShelves = shelfMap(before), afterShelves = shelfMap(ranches(after));
        const confirmed = refs.filter(ref => {
          const old = beforeShelves.get(targetKey(ref)), next = afterShelves.get(targetKey(ref));
          if (!next || shelfQuantity(next) < shelfQuantity(old)) return true;
          const had = arr(old?.lots).some(lot => arr(lot.stealers).some(gid => String(gid) === String(this.selfGid)));
          const has = arr(next?.lots).some(lot => arr(lot.stealers).some(gid => String(gid) === String(this.selfGid)));
          return !had && has;
        });
        const rewardConfirmed = refs.filter(ref => operationResults(reply).some(operation => this._rewardMatchesShelf(operation, ref)));
        const confirmedKeys = new Set([...confirmed, ...rewardConfirmed].map(targetKey));
        const count = confirmedKeys.size;
        result.count += count; result.changed ||= count > 0;
        if (count !== refs.length) throw uncertainty(`摘取已返回，仅核对 ${count}/${refs.length} 个货架目标；停止重试`);
        result.confirmedFriends++;
      } catch (error) { this._friendError(error, friend, result); }
      if (result.errors.length && result.errors.at(-1)?.gid === friend.gid && result.errors.at(-1)?.code === 0) break;
    }
    if (result.attemptedWrites) await this._verifyAfterWrite(() => this.refresh());
    else await this.refresh();
    result.message = `好友牧场摘取：扫描 ${result.scanned}，确认好友 ${result.confirmedFriends}，跳过 ${result.skipped}，已核对 ${result.count} 项${result.errors.length ? `，${result.errors.length} 项拒绝` : ''}`;
    return result;
  }
  _demoInit() {
    this.selfGid = 900001; this.account = { gid: this.selfGid, name: '演示牧场主', level: 1 };
    this.metadata = { animals: [{ animalId: 60001, itemId: 60001, name: '鸡', husbandryType: 1 }],
      items: [], goods: [{ id: 10002, shop_id: 5, item_id: 60001, price_id: 1007, price_count: 2 }] };
    this.shopGoods = [{ id: 10002, item_id: 60001, price: 2, unlocked: true }];
    this.ranches = [{ ranch_inst_id: 1, capacity: 2, animal_count: 1, husbandry_type: 1,
      animals: [{ ranch_inst_id: 1, animal_inst_id: 1, animal_id: 60001, can_harvest: true }], shelves: [], hazards: [] }];
    this.inventory = [{ id: 60001, count: 1 }, { id: 7001, count: 5 }, { id: 1007, count: 100 }];
    this.inventoryStatus = 'ready'; this.feedMachines = [{ instanceId: 10002, capacity: 10, feedCount: 5, isOwner: true, status: 1 }];
    this.friends = { status: 'ready', error: null, fetchedAt: stamp(), items: [
      { gid: this.selfGid, name: '演示牧场主', hostType: 0, isSelf: true, bigFarmStatus: null },
      { gid: 900002, name: '演示好友', hostType: 0, isSelf: false, bigFarmStatus: { can_steal: true } },
    ] };
    this._demoRanches = new Map([[900002, [{ ranch_inst_id: 2, capacity: 1, animal_count: 1, husbandry_type: 1,
      animals: [], shelves: [{ slot_index: 1, can_steal: true, total_remain: 2, lots: [{ remain_num: 2, can_steal: true }] }], hazards: [] }]]]);
    this._demoAnimalId = 100; this._syncAnimals(); this.status = 'ready'; this.fetchedAt = stamp();
  }
  async _demoRpc(service, method, request) {
    if (method === 'GetRanchDetail') return { ranches: clone(String(request.host_gid) === String(this.selfGid) ? this.ranches : this._demoRanches.get(Number(request.host_gid)) || []) };
    if (method === 'GetAll') return { game_friends: this.friends.items.map(friend => ({ gid: friend.gid, name: friend.name, host_type: friend.hostType, big_farm_status: friend.bigFarmStatus })) };
    if (method === 'ShopInfo') return { goods_list: clone(this.shopGoods) };
    if (method === 'GetBag') return { physical_items: clone(this.inventory) };
    if (method === 'GetRanchOpTimes') return { ops: [] };
    if (method === 'AllCells') return { facilities: this.feedMachines.map(machine => ({ instance_id: machine.instanceId, module_type: 8, capacity: machine.capacity, state: machine.status, feed_machine: { feed_count: machine.feedCount, is_owner: machine.isOwner } })) };
    if (method === 'AddFeed') {
      const machine = this.feedMachines.find(row => String(row.instanceId) === String(request.instance_id));
      machine.feedCount += request.add_count; this.inventory.find(row => Number(row.id) === 7001).count -= request.add_count;
      return {};
    }
    if (method === 'TriggerProduce') {
      const selected = new Set(arr(request.targets).map(targetKey));
      for (const ranch of this.ranches) for (const animal of ranch.animals || []) {
        if (selected.has(targetKey({ ranch_inst_id: ranch.ranch_inst_id, animal_inst_id: animal.animal_inst_id }))) {
          animal.producing = true; animal.can_deliver = false; animal.delivering_until_ms = Date.now() + 60000;
        }
      }
      return {};
    }
    if (method === 'HarvestRanch') {
      const selectedAnimals = new Set(arr(request.animals).map(targetKey)), selectedShelves = new Set(arr(request.shelves).map(targetKey));
      for (const ranch of this.ranches) {
        ranch.animals = ranch.animals.filter(animal => !(animal.can_harvest && (request.op === 1 || selectedAnimals.has(targetKey({ ranch_inst_id: ranch.ranch_inst_id, animal_inst_id: animal.animal_inst_id })))));
        ranch.animal_count = ranch.animals.length;
        for (const shelf of ranch.shelves) if (request.op === 1 || selectedShelves.has(targetKey({ ranch_inst_id: ranch.ranch_inst_id, slot_index: shelf.slot_index }))) { shelf.total_remain = 0; shelf.lots = []; shelf.can_collect = false; }
      }
      return {};
    }
    if (method === 'StealProduce') {
      for (const ranch of this._demoRanches.get(Number(request.host_gid)) || []) for (const shelf of ranch.shelves) {
        if (!request.targets.some(ref => targetKey(ref) === targetKey({ ranch_inst_id: ranch.ranch_inst_id, slot_index: shelf.slot_index }))) continue;
        shelf.total_remain = Math.max(0, shelfQuantity(shelf) - 1); shelf.can_steal = false;
        for (const lot of shelf.lots) { lot.remain_num = Math.max(0, Number(lot.remain_num) - 1); lot.can_steal = false; lot.stealers = [this.selfGid]; }
      }
      return {};
    }
    if (method === 'CleanRanch') {
      const rows = String(request.host_gid) === String(this.selfGid) ? this.ranches : this._demoRanches.get(Number(request.host_gid)) || [];
      for (const ranch of rows) ranch.hazards = arr(ranch.hazards).filter(hazard => !request.hazard_ids.some(id => String(id) === String(hazard.hazard_id ?? hazard.id)));
      return {};
    }
    if (method === 'BuyGoods') {
      const goods = this.shopGoods.find(row => String(row.id) === String(request.goods_id));
      let row = this.inventory.find(item => String(item.id) === String(goods.item_id));
      if (!row) { row = { id: goods.item_id, count: 0 }; this.inventory.push(row); }
      row.count += request.num; this.inventory.find(item => Number(item.id) === 1007).count -= request.price * request.num;
      return {};
    }
    if (method === 'PlaceAnimal') {
      for (const item of request.items) {
        const animal = this.animals.find(row => String(row.animalId) === String(item.animal_id));
        this.inventory.find(row => String(row.id) === String(animal.itemId)).count--;
        const ranch = this.ranches.find(row => String(row.ranch_inst_id) === String(item.ranch_inst_id));
        ranch.animals.push({ ranch_inst_id: ranch.ranch_inst_id, animal_inst_id: this._demoAnimalId++, animal_id: item.animal_id, can_harvest: false }); ranch.animal_count = ranch.animals.length;
      }
      return {};
    }
    throw new Error(`演示模式不支持 ${method}`);
  }
}
export { PASTURE };