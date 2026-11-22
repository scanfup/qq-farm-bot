import test from 'node:test';
import assert from 'node:assert/strict';
import { PastureService, PASTURE_COMMANDS, PASTURE_READ_COMMANDS } from './pasture.mjs';
const clone = value => structuredClone(value);
const metadata = () => ({
  animals: [{ animalId: 60001, itemId: 60001, name: '鸡', husbandryType: 1 },
    { animalId: 60002, itemId: 60002, name: '鸭', husbandryType: 1 },
    { animalId: 70001, itemId: 70001, name: '羊', husbandryType: 2 }],
  items: [], goods: [{ id: 10002, shop_id: 5, item_id: 60001, price_id: 1007 },
    { id: 10003, shop_id: 5, item_id: 60002, price_id: 1007 },
    { id: 10008, shop_id: 5, item_id: 70001, price_id: 1007 }],
});
function fake() {
  const data = {
    calls: [], identity: { gid: 1, name: 'me', level: 3 },
    own: [{ ranch_inst_id: 1, capacity: 3, animal_count: 1, husbandry_type: 1,
      animals: [{ ranch_inst_id: 1, animal_inst_id: 11, animal_id: 60001, can_harvest: true }],
      shelves: [{ slot_index: 1, can_collect: true, total_remain: 2, lots: [{ remain_num: 2 }] }], hazards: [{ hazard_id: 55 }] }],
    friend: [{ ranch_inst_id: 2, capacity: 2, animal_count: 0, husbandry_type: 1, animals: [],
      shelves: [{ slot_index: 1, can_steal: true, total_remain: 2, lots: [{ remain_num: 2, can_steal: true }] }], hazards: [{ hazard_id: 56 }] }],
    inventory: new Map([[60001, 2], [60002, 2], [70001, 1], [7001, 273], [1007, 12374]]),
    goods: [{ id: 10002, item_id: 60001, price: 2, unlocked: true }, { id: 10003, item_id: 60002, price: 3, unlocked: true }, { id: 10008, item_id: 70001, price: 5640, unlocked: false }],
    facilities: [{ instance_id: 10002, module_type: 8, capacity: 150, state: 1, feed_machine: { feed_count: 90, is_owner: true, status: 3 } }],
    preferences: { animalPriority: [60001], animalFallback: false, allowAnimalPurchase: false, maxAnimalSpendPerCycle: 0 },
    nextId: 100, failRead: null, onWrite: null,
  };
  data.rpc = async (service, method, request, options) => {
    data.calls.push({ service, method, request: clone(request), options });
    if (data.failRead === method && !options.write) throw new Error(`read ${method} failed`);
    if (method === 'GetRanchDetail') return { ranches: clone(String(request.host_gid) === String(data.identity.gid) ? data.own : data.friend) };
    if (method === 'GetBag') return { physical_items: [...data.inventory].filter(([id]) => id !== 1007).map(([id, count]) => ({ id, count })), virtual_items: [{ id: 1007, count: data.inventory.get(1007) }] };
    if (method === 'GetAll') return { game_friends: [{ gid: data.identity.gid, name: 'me' }, { gid: 2, name: 'friend', big_farm_status: { can_steal: true } }] };
    if (method === 'ShopInfo') return { goods_list: clone(data.goods) };
    if (method === 'GetRanchOpTimes') return { ops: [{ op_id: 11003, remaining_times: 1 }] };
    if (method === 'AllCells') return { facilities: clone(data.facilities) };
    if (data.onWrite) { const override = await data.onWrite(method, request); if (override !== undefined) return override; }
    if (method === 'BuyGoods') {
      const goods = data.goods.find(item => item.id === request.goods_id);
      data.inventory.set(goods.item_id, (data.inventory.get(goods.item_id) || 0) + request.num);
      data.inventory.set(1007, data.inventory.get(1007) - request.price * request.num); return {};
    }
    if (method === 'PlaceAnimal') {
      for (const item of request.items) {
        const ranch = data.own.find(row => row.ranch_inst_id === item.ranch_inst_id);
        assert.ok(ranch.animal_count < ranch.capacity, 'must never place over capacity');
        const animal = metadata().animals.find(row => row.animalId === item.animal_id);
        assert.ok(data.inventory.get(animal.itemId) > 0, 'must never use nonexistent stock');
        data.inventory.set(animal.itemId, data.inventory.get(animal.itemId) - 1);
        ranch.animals.push({ ranch_inst_id: ranch.ranch_inst_id, animal_inst_id: data.nextId++, animal_id: item.animal_id, can_harvest: false });
        ranch.animal_count = ranch.animals.length;
      }
      return {};
    }
    if (method === 'TriggerProduce') {
      for (const ranch of data.own) for (const animal of ranch.animals) if (request.targets.some(ref => ref.ranch_inst_id === ranch.ranch_inst_id && ref.animal_inst_id === animal.animal_inst_id)) {
        animal.producing = true; animal.can_deliver = false; animal.delivering_until_ms = Date.now() + 60000;
      }
      return {};
    }
    if (method === 'HarvestRanch') {
      for (const ranch of data.own) {
        ranch.animals = ranch.animals.filter(animal => !(animal.can_harvest && (request.op === 1 || request.animals.some(ref => ref.ranch_inst_id === ranch.ranch_inst_id && ref.animal_inst_id === animal.animal_inst_id))));
        ranch.animal_count = ranch.animals.length;
        for (const shelf of ranch.shelves) if (request.op === 1 || request.shelves.some(ref => ref.ranch_inst_id === ranch.ranch_inst_id && ref.slot_index === shelf.slot_index)) { shelf.total_remain = 0; shelf.lots = []; shelf.can_collect = false; }
      }
      return {};
    }
    if (method === 'CleanRanch') {
      for (const ranch of request.host_gid === data.identity.gid ? data.own : data.friend) ranch.hazards = ranch.hazards.filter(hazard => !request.hazard_ids.includes(hazard.hazard_id));
      return {};
    }
    if (method === 'StealProduce') {
      for (const ranch of data.friend) for (const shelf of ranch.shelves) if (request.targets.some(ref => ref.ranch_inst_id === ranch.ranch_inst_id && ref.slot_index === shelf.slot_index)) {
        shelf.total_remain--; shelf.can_steal = false; shelf.lots[0].remain_num--; shelf.lots[0].can_steal = false; shelf.lots[0].stealers = [data.identity.gid];
      }
      return {};
    }
    if (method === 'AddFeed') {
      const machine = data.facilities.find(item => item.instance_id === request.instance_id);
      machine.feed_machine.feed_count += request.add_count;
      data.inventory.set(7001, data.inventory.get(7001) - request.add_count); return {};
    }
    throw new Error(`unexpected ${service}.${method}`);
  };
  return data;
}
function service(data) {
  return new PastureService({ rpc: data.rpc, metadataProvider: metadata, identityProvider: async () => clone(data.identity), preferencesProvider: () => data.preferences });
}
const writes = data => data.calls.filter(call => call.options.write);

test('exports command lists and refresh uses scene2 resources and full quota', async () => {
  assert.deepEqual(PASTURE_READ_COMMANDS, ['pasture-refresh', 'pasture-visit']); assert.equal(PASTURE_COMMANDS.length, 8); assert.ok(PASTURE_COMMANDS.includes('pasture-produce'));
  const data = fake(), svc = service(data); await svc.run('pasture-refresh');
  assert.equal(svc.state().status, 'ready'); assert.equal(svc.state().friends.items.length, 2);
  assert.deepEqual(data.calls.find(call => call.method === 'GetBag').request, { global_scene_id: 2, tab_id: 0 });
  assert.deepEqual(data.calls.find(call => call.method === 'GetAll').request, { global_scene_id: 2 });
  assert.deepEqual(data.calls.find(call => call.method === 'GetRanchOpTimes').request.op_ids, [11003, 11004, 11005, 11006, 11007, 11008, 11009]);
  assert.equal(svc.inventory.find(item => item.id === 1007).count, 12374);
});
test('visit keeps preview out of journal result and clears on account switch', async () => {
  const data = fake(), svc = service(data); await svc.refresh();
  const result = await svc.run('pasture-visit', { gid: 2 }); assert.equal(result.preview.gid, 2); assert.equal(result.preview.ranches, undefined);
  assert.equal(svc.state().preview.ranches.length, 1); assert.equal(writes(data).length, 0);
  data.identity.gid = 3; await svc.refresh(); assert.equal(svc.state().preview, null);
});
test('every refresh query failure clears account, resources and preview', async () => {
  for (const method of ['GetRanchDetail', 'GetBag', 'GetAll', 'ShopInfo', 'GetRanchOpTimes', 'AllCells']) {
    const data = fake(), svc = service(data); await svc.refresh(); await svc.run('pasture-visit', { gid: 2 });
    data.failRead = method; await assert.rejects(() => svc.refresh());
    const state = svc.state(); assert.equal(state.status, 'error'); assert.equal(state.selfGid, 0); assert.equal(state.preview, null);
    assert.deepEqual(state.ranches, []); assert.deepEqual(state.animals, []); assert.deepEqual(state.feedMachines, []); assert.equal(state.inventoryStatus, 'error');
  }
});
test('harvest count measures animals and shelves, not ranch count; limited uses picked', async () => {
  const data = fake(), svc = service(data); await svc.refresh(); const all = await svc.run('pasture-harvest');
  assert.equal(all.count, 2); assert.equal(data.own[0].animals.length, 0); assert.equal(data.own[0].shelves[0].total_remain, 0); assert.equal(writes(data)[0].request.op, 1);
  const another = fake(), other = service(another); await other.refresh(); const picked = await other.run('pasture-harvest', { limit: 1 });
  assert.equal(picked.count, 1); assert.equal(writes(another)[0].request.op, 4); assert.equal(another.own[0].shelves[0].total_remain, 2);
});
test('harvest no state change is uncertain, partial confirmation retains actual count', async () => {
  const data = fake(), svc = service(data); await svc.refresh(); data.onWrite = async () => ({});
  await assert.rejects(() => svc.run('pasture-harvest'), error => error.uncertain === true && error.partialResult.count === 0);
  const second = fake(), other = service(second); await other.refresh(); second.onWrite = async method => { if (method === 'HarvestRanch') { second.own[0].animals = []; second.own[0].animal_count = 0; return {}; } };
  await assert.rejects(() => other.run('pasture-harvest'), error => error.uncertain === true && error.partialResult.count === 1 && error.partialResult.changed);
});
test('clean sends hazard IDs and counts only disappearance', async () => {
  const data = fake(), svc = service(data); await svc.refresh(); const result = await svc.run('pasture-clean');
  assert.equal(result.count, 1); assert.deepEqual(writes(data)[0].request, { host_gid: 1, hazard_ids: [55] });
  data.own[0].hazards = [{ hazard_id: 99 }]; data.onWrite = async () => ({});
  await assert.rejects(() => svc.run('pasture-clean'), error => error.uncertain === true && error.partialResult.count === 0);
});
test('friends clean and steal read after writes and refresh summaries', async () => {
  const data = fake(), svc = service(data); await svc.refresh();
  const clean = await svc.run('pasture-friends-clean', { maxFriends: 1 }); assert.equal(clean.count, 1);
  const steals = await svc.run('pasture-friends-steal', { gid: 2, limit: 1 }); assert.equal(steals.count, 1);
  const lastWrite = data.calls.findLastIndex(call => call.method === 'StealProduce');
  assert.ok(data.calls.slice(lastWrite + 1).some(call => call.method === 'GetRanchDetail' && call.request.host_gid === 2));
  assert.ok(data.calls.slice(lastWrite + 1).some(call => call.method === 'GetAll'));
});
test('friends unknown transport or uncertain-with-business-code stops immediately', async () => {
  for (const failure of [Object.assign(new Error('reset'), { code: 'ECONNRESET' }), Object.assign(new Error('unknown'), { code: 123, uncertain: true }), Object.assign(new Error('cleanup unknown'), { code: 123, cleanupFailed: true })]) {
    const data = fake(), svc = service(data); await svc.refresh(); data.onWrite = async () => { throw failure; };
    await assert.rejects(() => svc.run('pasture-friends-steal'), error => error.uncertain === true && error.partialResult.count === 0);
    assert.equal(writes(data).length, 1);
  }
});
test('friends explicit operation rejection is reported without invented successes', async () => {
  const data = fake(), svc = service(data); await svc.refresh(); data.onWrite = async () => ({ op_results: [{ code: 123 }] });
  const result = await svc.run('pasture-friends-clean'); assert.equal(result.count, 0); assert.ok(result.errors.length); assert.equal(result.changed, false);
});
test('steal needs quantity, self marker or actual rewards rather than input target count', async () => {
  const data = fake(), svc = service(data); await svc.refresh(); data.onWrite = async () => ({ op_results: [{}] });
  await assert.rejects(() => svc.run('pasture-friends-steal'), error => error.uncertain && error.partialResult.count === 0);
});
test('multiple priorities and fallback share latest capacity and never duplicate IDs', async () => {
  const data = fake(); data.own[0].capacity = 4; data.inventory.set(60001, 1); data.inventory.set(60002, 9);
  data.preferences = { animalPriority: [60001, 60002, 60001], animalFallback: true };
  const svc = service(data); await svc.refresh(); const result = await svc.run('pasture-place');
  assert.equal(result.count, 3); assert.equal(data.own[0].animal_count, 4);
  assert.deepEqual(writes(data).filter(call => call.method === 'PlaceAnimal').map(call => call.request.items[0].animal_id), [60001, 60002, 60002]);
  assert.equal(writes(data).some(call => call.method === 'BuyGoods'), false);
});
test('separate ranches share inventory and can continue next selected species', async () => {
  const data = fake(); data.own[0].capacity = 3; data.own.push({ ranch_inst_id: 3, capacity: 2, animal_count: 0, husbandry_type: 1, animals: [], shelves: [], hazards: [] });
  data.inventory.set(60001, 1); data.inventory.set(60002, 3); data.preferences.animalPriority = [60001, 60002];
  const svc = service(data); await svc.refresh(); const result = await svc.run('pasture-place');
  assert.equal(result.count, 4); assert.equal(data.inventory.get(60001), 0); assert.equal(data.inventory.get(60002), 0);
  assert.deepEqual(data.own.map(ranch => ranch.animal_count), [3, 2]);
});
test('exhausted preferences never fall back or buy unless explicitly authorized', async () => {
  const data = fake(); data.inventory.set(60001, 0); const svc = service(data); await svc.refresh();
  const none = await svc.run('pasture-place'); assert.equal(none.count, 0); assert.equal(writes(data).length, 0);
  data.preferences.animalFallback = true; const fallback = await svc.run('pasture-place', { limit: 1 }); assert.equal(fallback.count, 1); assert.equal(data.inventory.get(60002), 1);
});
test('automatic buying requires preference opt-in, real money and strict cycle budget', async () => {
  const data = fake(); data.inventory.set(60001, 0); data.preferences = { animalPriority: [60001], allowAnimalPurchase: true, maxAnimalSpendPerCycle: 2 };
  const svc = service(data); await svc.refresh(); const result = await svc.run('pasture-place');
  assert.equal(result.count, 1); assert.equal(result.spent, 2); assert.equal(writes(data).filter(call => call.method === 'BuyGoods').length, 1);
  assert.equal(data.inventory.get(1007), 12372); assert.equal(data.inventory.get(60001), 0);
  const poor = fake(); poor.inventory.set(60001, 0); poor.inventory.set(1007, 1); poor.preferences = data.preferences;
  const second = service(poor); await second.refresh(); assert.equal((await second.run('pasture-place')).count, 0); assert.equal(writes(poor).length, 0);
});
test('unconfirmed purchase stops uncertain before PlaceAnimal, without retrying', async () => {
  const data = fake(); data.inventory.set(60001, 0); data.preferences = { animalPriority: [60001], allowAnimalPurchase: true, maxAnimalSpendPerCycle: 100 };
  const svc = service(data); await svc.refresh(); data.onWrite = async method => method === 'BuyGoods' ? {} : undefined;
  await assert.rejects(() => svc.run('pasture-place'), error => error.uncertain && error.partialResult.count === 0);
  assert.deepEqual(writes(data).map(call => call.method), ['BuyGoods']);
});
test('unconfirmed placement never pretends to consume inventory or fill capacity', async () => {
  const data = fake(), svc = service(data); await svc.refresh(); data.onWrite = async () => ({});
  await assert.rejects(() => svc.run('pasture-place'), error => error.uncertain && error.partialResult.count === 0);
  assert.equal(writes(data).length, 1); assert.equal(data.inventory.get(60001), 2);
});
test('manual buy is explicit authorization and ignores auto-buy flag but checks whole bill', async () => {
  const data = fake(), svc = service(data); await svc.refresh();
  const result = await svc.run('pasture-buy', { animalId: 60001, count: 2, expectedUnitPrice: 2 });
  assert.equal(result.count, 2); assert.equal(result.spent, 4); assert.equal(data.inventory.get(1007), 12370);
  assert.ok(writes(data).every(call => call.request.num === 1 && call.request.price === 2 && call.request.auto_add === false));
  const poor = fake(); poor.inventory.set(1007, 3); const second = service(poor); await second.refresh();
  await assert.rejects(() => second.run('pasture-buy', { animalId: 60001, count: 2 }), /余额不足/); assert.equal(writes(poor).length, 0);
});
test('manual expected price mismatch or locked animal refuses before first write', async () => {
  const data = fake(), svc = service(data); await svc.refresh();
  await assert.rejects(() => svc.run('pasture-buy', { animalId: 60001, count: 1, expectedUnitPrice: 1 }), /单价已变化/);
  await assert.rejects(() => svc.run('pasture-buy', { animalId: 70001, count: 1 }), /未解锁/);
  assert.equal(writes(data).length, 0);
});
test('buying rechecks each unit price, does not exceed original full bill on repricing', async () => {
  const data = fake(), svc = service(data); await svc.refresh();
  let bought = false; data.onWrite = async method => { if (method === 'BuyGoods' && !bought) { bought = true; data.goods[0].price = 20; } };
  const result = await svc.run('pasture-buy', { animalId: 60001, count: 2 });
  assert.equal(result.count, 1); assert.equal(result.spent, 2); assert.equal(writes(data).length, 1);
});
test('feed requires explicit owner and active facility, not unknown or virtual state', async () => {
  for (const variation of [{ is_owner: undefined, state: 1 }, { is_owner: true, state: 2 }, { is_owner: false, state: 1 }]) {
    const data = fake(); data.facilities[0].feed_machine.is_owner = variation.is_owner; data.facilities[0].state = variation.state;
    const svc = service(data); await svc.refresh(); assert.equal((await svc.run('pasture-feed')).count, 0); assert.equal(writes(data).length, 0);
  }
});
test('feed exact count follows machine increment and physical stock decrement', async () => {
  const data = fake(), svc = service(data); await svc.refresh(); const result = await svc.run('pasture-feed', { limit: 20 });
  assert.equal(result.count, 20); assert.equal(data.facilities[0].feed_machine.feed_count, 110); assert.equal(data.inventory.get(7001), 253);
  assert.deepEqual(writes(data)[0].request, { instance_id: 10002, add_count: 20, use_gold: false, host_gid: 0 });
});
test('feed no delta or read-after-write failure is uncertain and stops', async () => {
  const data = fake(), svc = service(data); await svc.refresh(); data.onWrite = async () => ({});
  await assert.rejects(() => svc.run('pasture-feed', { limit: 1 }), error => error.uncertain && error.partialResult.count === 0);
  const next = fake(), second = service(next); await second.refresh(); next.onWrite = async () => { next.failRead = 'GetBag'; };
  await assert.rejects(() => second.run('pasture-place', { limit: 1 }), error => error.uncertain && second.state().status === 'error');
});
test('inventory aggregates duplicate physical and virtual stacks safely', async () => {
  const data = fake(), original = data.rpc; data.rpc = async (...args) => args[1] === 'GetBag' ? { physical_items: [{ id: 60001, count: 1 }, { id: 60001, count: 2 }], virtual_items: [{ id: 1007, count: 10 }, { id: 1007, count: 20 }] } : original(...args);
  const svc = service(data); await svc.refresh(); assert.equal(svc.animals[0].count, 3); assert.equal(svc.inventory.find(item => item.id === 1007).count, 30);
});
test('demo mutates harvest, placement, feed, purchase and friend shelf without real rpc', async () => {
  const svc = new PastureService({ demo: true, preferencesProvider: () => ({ animalPriority: [60001] }) });
  const preview = await svc.run('pasture-visit', { gid: 900002 }); assert.equal(preview.preview.gid, 900002);
  assert.equal((await svc.run('pasture-harvest')).count, 1); assert.equal(svc.state().ranches[0].animals.length, 0);
  assert.equal((await svc.run('pasture-place', { limit: 1 })).count, 1);
  assert.equal((await svc.run('pasture-feed', { limit: 1 })).count, 1);
  assert.equal((await svc.run('pasture-buy', { animalId: 60001, count: 1 })).spent, 2);
  assert.equal((await svc.run('pasture-friends-steal')).count, 1);
  svc.invalidate(); assert.equal(svc.state().selfGid, 0); assert.equal(svc.state().preview, null);
});

test('all-friend operations scan members without summaries and reject unknown explicit targets',async()=>{
  const data=fake(),original=data.rpc;data.rpc=async(s,m,r,o)=>m==='GetAll'?{game_friends:[{gid:1,name:'me'},{gid:2,name:'without summary'}]}:original(s,m,r,o);
  const svc=service(data);await svc.refresh();const result=await svc.run('pasture-friends-clean');assert.equal(result.scanned,1);assert.equal(result.confirmedFriends,1);assert.equal(result.count,1);assert.equal(result.skipped,0);
  const second=await svc.run('pasture-friends-clean');assert.equal(second.scanned,1);assert.equal(second.skipped,1);await assert.rejects(()=>svc.run('pasture-friends-clean',{gid:999}),/不在场景2/);
});
test('an unrelated reward cannot confirm unchanged shelves and mixed targets cannot be invented',async()=>{
  for(const partial of [false,true]){const data=fake();data.friend[0].shelves.push({slot_index:2,can_steal:true,total_remain:2,lots:[{remain_num:2,can_steal:true}]});data.onWrite=async m=>{if(m!=='StealProduce')return;if(partial){data.friend[0].shelves[0].total_remain--;data.friend[0].shelves[0].lots[0].remain_num--;}return{op_results:[{facility_inst_id:777,target_id:999,rewards:[{id:1007,count:99}]}]};};const svc=service(data);await svc.refresh();await assert.rejects(()=>svc.run('pasture-friends-steal'),e=>e.uncertain===true&&e.partialResult.count===(partial?1:0));assert.equal(writes(data).length,1);}
});
test('self grass-machine writes use native watchGid zero and never purchase feed',async()=>{
  const data=fake(),svc=service(data);await svc.refresh();await svc.run('pasture-feed',{limit:1});const request=writes(data).find(c=>c.method==='AddFeed').request;assert.equal(request.host_gid,0);assert.equal(request.use_gold,false);assert.equal(request.add_count,1);assert.equal(writes(data).some(c=>c.method==='BuyGoods'),false);
});


test('produce selects only stage3 deliverable, non-producing, unblocked animals and sends host_gid zero', async () => {
  const data = fake(), eligible = data.own[0].animals[0];
  Object.assign(eligible, { stage: 3, can_deliver: true, producing: false, grass_blocked: false, produce_count: 0 });
  const svc = service(data); await svc.refresh(); const result = await svc.run('pasture-produce');
  assert.equal(result.count, 1); const call = writes(data).find(item => item.method === 'TriggerProduce');
  assert.deepEqual(call.request, { host_gid: 0, targets: [{ ranch_inst_id: 1, animal_inst_id: 11 }] });
  assert.equal(eligible.producing, true); assert.equal(eligible.can_deliver, false);
});

test('produce skips each unsafe state without writing', async () => {
  for (const patch of [{ stage: 2, can_deliver: true }, { stage: 3, can_deliver: false }, { stage: 3, can_deliver: true, producing: true }, { stage: 3, can_deliver: true, grass_blocked: true }, { stage: 3, can_deliver: true, producing: false, grass_blocked: false }]) {
    const data = fake(); Object.assign(data.own[0].animals[0], patch);
    if (Object.keys(patch).length === 5) data.own[0].animals[0].can_deliver = true;
    const svc = service(data); await svc.refresh(); const result = await svc.run('pasture-produce');
    if (patch.stage === 3 && patch.can_deliver === true && patch.producing === false && patch.grass_blocked === false) assert.equal(result.count, 1);
    else assert.equal(result.count, 0);
    assert.equal(writes(data).some(item => item.method === 'TriggerProduce'), patch.stage === 3 && patch.can_deliver === true && patch.producing === false && patch.grass_blocked === false);
  }
});

test('produce limit and partial confirmation remain conservative', async () => {
  const data = fake(); Object.assign(data.own[0].animals[0], { stage: 3, can_deliver: true, producing: false, grass_blocked: false });
  const svc = service(data); await svc.refresh(); const limited = await svc.run('pasture-produce', { limit: 1 }); assert.equal(limited.count, 1);
  const second = fake(); Object.assign(second.own[0].animals[0], { stage: 3, can_deliver: true, producing: false, grass_blocked: false });
  second.onWrite = async method => { if (method === 'TriggerProduce') return {}; };
  const broken = service(second); await broken.refresh(); await assert.rejects(() => broken.run('pasture-produce'), error => error.uncertain && error.partialResult.count === 0);
});

test('produce transport failure is uncertain and never retried', async () => {
  const data = fake(); Object.assign(data.own[0].animals[0], { stage: 3, can_deliver: true, producing: false, grass_blocked: false });
  data.onWrite = async method => { if (method === 'TriggerProduce') throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }); };
  const svc = service(data); await svc.refresh(); await assert.rejects(() => svc.run('pasture-produce'), error => error.uncertain);
  assert.equal(writes(data).filter(item => item.method === 'TriggerProduce').length, 1);
});

test('demo produce transitions an injected eligible animal without bridge RPC', async () => {
  const svc = new PastureService({ demo: true, preferencesProvider: () => ({}) });
  const animal = svc.ranches[0].animals[0]; Object.assign(animal, { stage: 3, can_deliver: true, producing: false, grass_blocked: false });
  const result = await svc.run('pasture-produce'); assert.equal(result.count, 1); assert.equal(animal.producing, true); assert.equal(animal.can_deliver, false);
});
