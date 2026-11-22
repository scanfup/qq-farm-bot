import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {COMMANDS} from './service.mjs';
const html=readFileSync(new URL('./public/index.html',import.meta.url),'utf8');
const js=readFileSync(new URL('./public/app.js',import.meta.url),'utf8');
const navigation=readFileSync(new URL('./public/navigation.js',import.meta.url),'utf8');
test('all literal UI id selectors exist exactly once in the page',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,'duplicate HTML id');
  for(const m of (js+'\n'+navigation).matchAll(/\$\(['"]#([a-zA-Z0-9_-]+)['"]\)/g))assert.ok(ids.includes(m[1]),'missing HTML id '+m[1]);
});
test('all rendered write buttons are backed by serialized app commands',()=>{
  for(const m of html.matchAll(/\bdata-(?:pasture-)?command="([^"]+)"/g))assert.ok(COMMANDS.includes(m[1]),'unsupported UI command '+m[1]);
  assert.match(html,/data-pasture-command="pasture-produce"/);assert.ok(js.includes("'pasture-produce'"));
});
test('UI syntax stays valid and security-sensitive labels make purchase and inventory scope explicit',()=>{
  assert.doesNotThrow(()=>new vm.Script(js));assert.match(html,/自动购买默认关闭/);assert.match(html,/用库存补牧草/);assert.match(html,/单周期购买预算/);assert.match(html,/牧场托管无需选择种子/);assert.match(js,/expectedUnitPrice: Number\(animal.price\)/);
});

test('three distinct route sections and an independent log sidebar replace the long page',()=>{
  assert.deepEqual([...html.matchAll(/data-page="([^"\s]+)"/g)].map(m=>m[1]),['farm','pasture','settings']);
  assert.match(html,/<aside id="activitySidebar"/);assert.ok(html.indexOf('id="logsList"')>html.indexOf('</main>'));assert.match(html,/<details id="landsDisclosure"[^>]*>/);assert.doesNotMatch(html,/<details id="landsDisclosure"[^>]*\bopen\b/);assert.match(html,/src="\/navigation.js"/);
});

test('farm friends and self management share the farm page like pasture',()=>{const farm=html.slice(html.indexOf('data-page="farm"'),html.indexOf('data-page="pasture"'));assert.ok(farm.includes('id="friendsTitle"'));assert.ok(farm.includes('id="friendList"'));assert.ok(farm.includes('id="friendStealAllBtn"'));assert.ok(farm.includes('id="friendCareAllBtn"'));assert.ok(!html.includes('data-route="friends"'));assert.ok(farm.indexOf('id="landsDisclosure"')<farm.indexOf('id="friendList"'));});
test('each scene exposes its own one-click management button without cross-scene wiring',()=>{
  const farm=html.slice(html.indexOf('data-page="farm"'),html.indexOf('data-page="pasture"'));
  const pasture=html.slice(html.indexOf('data-page="pasture"'),html.indexOf('data-page="settings"'));
  assert.match(farm,/data-command="farm-manage"/);assert.ok(!farm.includes('data-pasture-command="pasture-manage"'));
  assert.match(pasture,/data-pasture-command="pasture-manage"/);assert.ok(!pasture.includes('data-command="farm-manage"'));
  assert.match(farm,/全部好友帮忙务农、偷菜/);assert.match(pasture,/牧场一键务农（含全部好友）/);
});
