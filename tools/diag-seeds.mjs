// 种子商店清单：列出可购买种子（含价格、等级要求、限购）
import { Bridge } from './core.mjs';
import { buildShopInfo, decodeShopReply, decodeBagReply, parse, fields, num, str, decodeAllLandsReply } from './farm.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: () => { } });

  // 1) 种子商店 (shop_id=2)
  const sr = await b.call('gamepb.shoppb.ShopService', 'ShopInfo', buildShopInfo(2));
  const goods = decodeShopReply(sr.body);
  console.log(`[商店] 种子商店共 ${goods.length} 个商品\n`);

  // 2) 背包（已有种子数量）
  const br = await b.call('gamepb.itempb.ItemService', 'Bag', Buffer.alloc(0));
  const bag = decodeBagReply(br.body);
  const bagMap = new Map(bag.items.map(i => [i.id, i.count]));

  // 3) 自家地块：从已种作物反推种子->名称
  const ar = await b.call('gamepb.plantpb.PlantService', 'AllLands', Buffer.alloc(0));
  const nameBySeed = new Map();
  for (const l of decodeAllLandsReply(ar.body).lands) {
    if (l.plant && l.plant.id && l.plant.name) {
      // 植物 id 与种子 id 不同，但商店的 item_id 就是种子 id，暂以植物名做参考
      nameBySeed.set(l.plant.id, l.plant.name);
    }
  }

  console.log('ID        单价   每次  限购   已购  等级  背包  解锁');
  console.log('-------------------------------------------------------');
  for (const g of goods.sort((a, b2) => a.price - b2.price)) {
    const conds = (g.conds || []).map(c => c.type === 1 ? `lv${c.param}` : `cond${c.type}`).join(',') || '-';
    const inBag = bagMap.get(g.itemId);
    console.log(
      String(g.itemId).padEnd(10) +
      String(g.price).padEnd(6) +
      String(g.itemCount).padEnd(6) +
      String(g.limitCount || '-').padEnd(6) +
      String(g.boughtNum || 0).padEnd(6) +
      conds.padEnd(6) +
      String(inBag === undefined ? '-' : inBag).padEnd(6) +
      (g.unlocked ? '是' : '否'),
    );
  }

  console.log('\n[背包中的种子类物品]');
  for (const it of bag.items) {
    if (it.id >= 20000 && it.id < 999999 && it.id !== 1001 && it.id !== 1002) {
      console.log(`  ${String(it.id).padEnd(10)} x${it.count}`);
    }
  }
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
