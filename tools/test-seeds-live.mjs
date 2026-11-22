// Read-only acceptance: compare external Bag decoding with the game's decoder.
import { FarmApp } from '../web/service.mjs';
import { Bridge } from './core.mjs';
import { aggregateItems } from '../web/seed-inventory.mjs';
const bridge = new Bridge();
let bagBody;
const call = bridge.call.bind(bridge);
bridge.call = async (...args) => {
  const reply = await call(...args);
  if (args[1] === 'Bag') bagBody = reply.body;
  return reply;
};
const app = new FarmApp({ bridge, journal: false });
try {
  await app.connect();
  if (app.inventory.status !== 'ready' || app.inventory.source !== '游戏实时配置') throw new Error(app.inventory.error || app.inventory.warning || '实时种子库存未加载');
  const nativeItems = await bridge.evaluate(`(() => {
    const hex = ${JSON.stringify(bagBody.toString('hex'))};
    const bytes = new Uint8Array(hex.match(/../g).map(b => parseInt(b, 16)));
    const bag = System.get('chunks:///_virtual/itempb.ts').gamepb.itempb.BagReply.decode(bytes).item_bag;
    return bag.items.map(item => ({ id: Number(item.id), count: Number(item.count.toString()) }));
  })()`);
  const totals = aggregateItems(nativeItems);
  for (const seed of app.seeds) if (totals.get(seed.seed) !== seed.count) throw new Error('原生解码库存不一致：' + seed.seed);
  console.log(JSON.stringify({ live: true, nativeDecoderAgrees: true, inventory: app.inventory, seedKinds: app.seeds.length, totalSeeds: app.seeds.reduce((sum,item) => sum + item.count, 0), seeds: app.seeds }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await app.close(); }
