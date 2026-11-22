// The item table establishes seed identity; numeric ID ranges are not evidence.
export function seedMetadataExpression(itemIds) {
  return `(() => {
    const factory = globalThis.System?.get('chunks:///_virtual/Oops.ts')?.oops?.configFactory;
    const plantTable = factory?.configs?.get('Plant')?._configMap;
    const itemTable = factory?.configs?.get('ItemInfo')?._configMap;
    if (!plantTable || typeof plantTable.values !== 'function' || !itemTable || typeof itemTable.get !== 'function') return { available: false, seeds: [] };
    const wanted = new Set(${JSON.stringify(itemIds)});
    const plants = new Map();
    for (const plant of plantTable.values()) {
      const id = Number(plant.seed_id);
      if (wanted.has(id) && !plants.has(id)) plants.set(id, plant);
    }
    const seeds = [];
    for (const id of wanted) {
      const item = itemTable.get(id) || itemTable.get(String(id));
      const plant = plants.get(id);
      if (Number(item?.type) !== 5 && !plant) continue;
      seeds.push({ seed: id, name: plant?.name || item?.name || ('种子 ' + id), canPlant: !!plant, plantId: plant ? Number(plant.id) : null });
    }
    return { available: true, seeds };
  })()`;
}

export function aggregateItems(items) {
  const totals = new Map();
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || !Number.isSafeInteger(item.count) || item.count < 0) throw new Error('背包物品 ID 或数量无效');
    const count = (totals.get(item.id) || 0) + item.count;
    if (!Number.isSafeInteger(count)) throw new Error('背包物品数量超出精确整数范围');
    totals.set(item.id, count);
  }
  return totals;
}

export function ownedSeeds(totals, metadata) {
  const unique = new Map();
  for (const item of metadata) {
    const count = totals.get(item.seed) || 0;
    if (count > 0) unique.set(item.seed, { ...item, count });
  }
  return [...unique.values()].sort((a,b) => b.count - a.count || a.seed - b.seed);
}
