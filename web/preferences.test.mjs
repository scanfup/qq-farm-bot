import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_PREFERENCES, PreferencesStore, validatePreferences, orderByPriority } from './preferences.mjs';

const temporary = t => {
  const dir = mkdtempSync(join(tmpdir(), 'farm-preferences-'));
  // Cleanup is limited to the exact absolute directory minted for this test.
  const exact = resolve(dir);
  assert.equal(exact, dir);
  t.after(() => rmSync(exact, { recursive: true, force: true }));
  return dir;
};

test('defaults and validated results are independent copies', () => {
  const a = validatePreferences({}); a.seedPriority.push(42);
  assert.deepEqual(DEFAULT_PREFERENCES.seedPriority, []);
  assert.deepEqual(validatePreferences({}).seedPriority, []);
  const original = { seedPriority: [7, 3] }; const value = validatePreferences(original);
  value.seedPriority.push(4); assert.deepEqual(original.seedPriority, [7, 3]);
});
test('partial updates retain declared unavailable IDs without runtime catalog validation', () => {
  const current = validatePreferences({ seedPriority: [999999999], animalPriority: [60001] });
  assert.deepEqual(validatePreferences({ animalFallback: true }, current), { ...current, animalFallback: true });
});
test('rejects invalid IDs, too many and duplicates', () => {
  for (const ids of [[0], [-1], ['2'], [1.2], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], [1, 1], Array.from({length:21}, (_, i) => i + 1), '1,2', null]) {
    assert.throws(() => validatePreferences({ seedPriority: ids }), /seedPriority/);
    assert.throws(() => validatePreferences({ animalPriority: ids }), /animalPriority/);
  }
  assert.equal(validatePreferences({ seedPriority: Array.from({length:20},(_,i)=>i+1) }).seedPriority.length, 20);
});
test('strict objects, booleans, unknown keys and purchase budget rules', () => {
  for (const input of [null, [], 'x', 2]) assert.throws(() => validatePreferences(input));
  for (const key of ['enabled', 'monitor', 'monitorEnabled', '__unexpected__']) assert.throws(() => validatePreferences({ [key]: true }), /不支持/);
  for (const key of ['seedFallback', 'animalFallback', 'allowAnimalPurchase']) for (const value of [0,1,'true',null]) assert.throws(() => validatePreferences({[key]:value}));
  for (const budget of [-1,1.5,'10',Infinity,1000001,Number.MAX_SAFE_INTEGER+1]) assert.throws(() => validatePreferences({maxAnimalSpendPerCycle:budget}));
  assert.throws(() => validatePreferences({allowAnimalPurchase:true}), /预算/);
  assert.equal(validatePreferences({allowAnimalPurchase:true,maxAnimalSpendPerCycle:1000000}).maxAnimalSpendPerCycle,1000000);
  const buying = validatePreferences({allowAnimalPurchase:true,maxAnimalSpendPerCycle:10});
  assert.throws(() => validatePreferences({maxAnimalSpendPerCycle:0},buying), /预算/);
  assert.equal(validatePreferences({allowAnimalPurchase:false,maxAnimalSpendPerCycle:0},buying).allowAnimalPurchase,false);
});
test('sorts by selected priority and excludes unavailable without silent fallback', () => {
  const items=[{id:1,count:1},{id:2,count:0},{id:3,count:4},{id:4,count:2}];
  const before=structuredClone(items), ids=[3,2,1];
  assert.deepEqual(orderByPriority(items,ids,{idKey:'id',available:i=>i.count>0}).map(i=>i.id),[3,1]);
  assert.deepEqual(orderByPriority(items,[2],{idKey:'id',available:i=>i.count>0}),[]);
  assert.deepEqual(orderByPriority(items,[],{idKey:'id'}),[]);
  assert.deepEqual(items,before);assert.deepEqual(ids,[3,2,1]);
});
test('fallback explicitly appends other available candidates and deduplicates IDs', () => {
  const items=[{seed:1,count:0},{seed:2,count:1},{seed:2,count:3},{seed:3,count:2},{seed:4,count:0}];
  assert.deepEqual(orderByPriority(items,[3,3,1],{idKey:'seed',fallback:true,available:i=>i.count>0}).map(i=>i.seed),[3,2]);
  assert.deepEqual(orderByPriority(items,[1],{idKey:'seed',fallback:false,available:i=>i.count>0}),[]);
  assert.deepEqual(orderByPriority(items,[],{idKey:'seed',fallback:true,available:i=>i.count>0}).map(i=>i.seed),[2,3]);
});
test('loads defaults, persists atomic updates and preserves live/demo separation', t => {
  const dataDir=temporary(t);
  const live=new PreferencesStore({dataDir});const demo=new PreferencesStore({dataDir,demo:true});
  assert.deepEqual(live.state(),validatePreferences({}));
  live.update({seedPriority:[20040,20002],seedFallback:true,animalPriority:[60001],allowAnimalPurchase:true,maxAnimalSpendPerCycle:40});
  demo.update({animalPriority:[70001],animalFallback:true});
  assert.deepEqual(new PreferencesStore({dataDir}).state(),live.state());
  assert.deepEqual(new PreferencesStore({dataDir,demo:true}).state(),demo.state());
  assert.notDeepEqual(live.state(),demo.state());
  const copy=live.state();copy.seedPriority.length=0;assert.deepEqual(live.state().seedPriority,[20040,20002]);
  const returned=live.update({seedFallback:false});returned.animalPriority.length=0;assert.deepEqual(live.state().animalPriority,[60001]);
  assert.equal(JSON.parse(readFileSync(join(dataDir,'live-preferences.json'),'utf8')).allowAnimalPurchase,true);
  assert.equal(Object.hasOwn(live.state(),'enabled'),false);
});
test('corrupted and semantically invalid files refuse startup', t => {
  const dataDir=temporary(t), path=join(dataDir,'live-preferences.json');
  for(const text of ['{broken',JSON.stringify({monitorEnabled:true}),JSON.stringify({animalPriority:[-1]}),JSON.stringify({allowAnimalPurchase:true,maxAnimalSpendPerCycle:0})]){
    writeFileSync(path,text);assert.throws(()=>new PreferencesStore({dataDir}),/偏好文件损坏/);
  }
});
test('failed persistence leaves memory and existing file unchanged', t => {
  const dataDir=temporary(t), store=new PreferencesStore({dataDir});
  store.update({seedPriority:[20040]});const before=store.state();const text=readFileSync(store.filePath,'utf8');
  const obstruction=join(dataDir,'is-a-directory');mkdirSync(obstruction);store.filePath=obstruction;
  assert.throws(()=>store.update({seedPriority:[20002]}));
  assert.deepEqual(store.state(),before);assert.equal(readFileSync(join(dataDir,'live-preferences.json'),'utf8'),text);
});
test('nonpersistent store never loads or writes disk and still validates', t => {
  const dataDir=temporary(t);writeFileSync(join(dataDir,'live-preferences.json'),'{broken');
  const store=new PreferencesStore({dataDir,persist:false});store.update({animalPriority:[60002]});
  assert.deepEqual(store.state().animalPriority,[60002]);assert.equal(readFileSync(join(dataDir,'live-preferences.json'),'utf8'),'{broken');
  assert.deepEqual(new PreferencesStore({persist:false}).state(),validatePreferences({}));
  assert.throws(()=>store.update({enabled:true}));
});
