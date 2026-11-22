import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PREFERENCES = Object.freeze({
  seedPriority: Object.freeze([]), animalPriority: Object.freeze([]),
  seedFallback: false, animalFallback: false,
  allowAnimalPurchase: false, maxAnimalSpendPerCycle: 0,
});
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const keys = Object.keys(DEFAULT_PREFERENCES);

/** Validate syntax only. Unknown/empty-stock catalog entries remain selectable so a
 * later inventory refresh cannot silently change the user's declared priority. */
export function validatePreferences(input, current = DEFAULT_PREFERENCES) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('偏好设置必须为对象');
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new TypeError(`不支持的偏好字段：${key}`);
  const merged = {};
  for (const key of keys) merged[key] = own(input, key) ? input[key] : current[key];
  for (const key of ['seedPriority', 'animalPriority']) {
    const value = merged[key];
    if (!Array.isArray(value) || value.length > 20 || value.some(id => !positiveId(id)) || new Set(value).size !== value.length) throw new TypeError(`${key} 必须为最多20个不重复的安全正整数ID`);
    merged[key] = [...value];
  }
  for (const key of ['seedFallback', 'animalFallback', 'allowAnimalPurchase']) if (typeof merged[key] !== 'boolean') throw new TypeError(`${key} 必须为布尔值`);
  if (!Number.isSafeInteger(merged.maxAnimalSpendPerCycle) || merged.maxAnimalSpendPerCycle < 0 || merged.maxAnimalSpendPerCycle > 1000000) throw new TypeError('maxAnimalSpendPerCycle 必须为0至1000000的安全整数');
  if (merged.allowAnimalPurchase && merged.maxAnimalSpendPerCycle === 0) throw new TypeError('允许购买动物时，每轮预算必须大于0');
  return merged;
}

/** Return available explicitly selected candidates in declared order. An unavailable
 * selected ID is skipped, but never replaced by an unselected ID without fallback. */
export function orderByPriority(items, ids, { idKey, fallback = false, available = () => true } = {}) {
  if (!Array.isArray(items) || !Array.isArray(ids) || typeof idKey !== 'string' || !idKey || typeof fallback !== 'boolean' || typeof available !== 'function') throw new TypeError('优先级排序参数无效');
  const byId = new Map();
  for (const item of items) {
    const id = item?.[idKey];
    if (positiveId(id) && !byId.has(id) && available(item)) byId.set(id, item);
  }
  const result = [], seen = new Set();
  for (const id of ids) if (!seen.has(id)) {
    seen.add(id);
    if (byId.has(id)) result.push(byId.get(id));
  }
  if (fallback) for (const [id, item] of byId) if (!seen.has(id)) { seen.add(id); result.push(item); }
  return result;
}

/** Persistent preferences only: no task state, monitor enable flag or automatic
 * execution is restored. Invalid on-disk data is a startup error, never ignored. */
export class PreferencesStore {
  constructor({ dataDir, demo = false, persist = true } = {}) {
    if (typeof demo !== 'boolean' || typeof persist !== 'boolean') throw new TypeError('demo和persist必须为布尔值');
    if (persist && (typeof dataDir !== 'string' || !dataDir)) throw new TypeError('持久化偏好需要dataDir');
    this.persist = persist;
    this.dataDir = dataDir;
    this.filePath = dataDir ? join(dataDir, `${demo ? 'demo' : 'live'}-preferences.json`) : null;
    this.value = validatePreferences({});
    if (persist) {
      let text;
      try { text = readFileSync(this.filePath, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (text !== undefined) {
        try { this.value = validatePreferences(JSON.parse(text)); }
        catch (error) { throw new Error(`偏好文件损坏，拒绝启动：${error.message}`, { cause: error }); }
      }
    }
  }
  state() { return structuredClone(this.value); }
  update(input) {
    const value = validatePreferences(input, this.value);
    if (this.persist) {
      mkdirSync(this.dataDir, { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        renameSync(temporary, this.filePath);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* Preserve original write error. */ }
        throw error;
      }
    }
    this.value = value;
    return this.state();
  }
}
export default PreferencesStore;
