// 从解密的 Plant.json 生成「种子ID -> 作物信息」映射
import { readFileSync, writeFileSync } from 'node:fs';

const arr = JSON.parse(readFileSync('out/cfg/Plant.decoded.json', 'utf8'));

// grow_phases 形如 "种子:30;发芽:30;成熟:0;" —— 冒号后为秒数，累加即总生长时长
function totalGrowSec(s) {
  if (!s) return 0;
  let sum = 0;
  for (const part of String(s).split(';')) {
    const seg = part.split(':');
    if (seg.length === 2) {
      const n = Number(seg[1]);
      if (Number.isFinite(n)) sum += n;
    }
  }
  return sum;
}

const map = {};
for (const p of arr) {
  if (!p || !p.seed_id) continue;         // 无种子的跳过（如系统作物）
  const seed = Number(p.seed_id);
  if (map[seed]) continue;                 // 保留首个
  map[seed] = {
    seed,
    plantId: Number(p.id),
    name: String(p.name || ''),
    growSec: totalGrowSec(p.grow_phases),
    exp: Number(p.exp || 0),
    lv: Number(p.land_level_need || 0),
    seasons: Number(p.seasons || 1),
    fruitId: p.fruit ? Number(p.fruit.id) : 0,
    fruitCount: p.fruit ? Number(p.fruit.count) : 0,
  };
}

writeFileSync('out/cfg/seed-map.json', JSON.stringify(map, null, 1));

const keys = Object.keys(map);
console.log(`[生成] out/cfg/seed-map.json  共 ${keys.length} 个种子映射\n`);
console.log('种子ID   等级  生长时长      经验  作物名');
console.log('------------------------------------------------');
for (const k of keys.sort((a, b) => map[a].seed - map[b].seed).slice(0, 30)) {
  const v = map[k];
  const h = v.growSec >= 3600 ? (v.growSec / 3600).toFixed(1) + 'h' : v.growSec + 's';
  console.log(`${String(k).padEnd(9)}${('lv' + v.lv).padEnd(6)}${h.padEnd(14)}${String(v.exp).padEnd(6)}${v.name}`);
}
console.log(`\n总计 ${keys.length} 个`);
