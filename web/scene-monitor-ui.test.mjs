import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import{readFileSync}from'node:fs';
const source=readFileSync(new URL('./public/app.js',import.meta.url),'utf8'),html=readFileSync(new URL('./public/index.html',import.meta.url),'utf8');
function fixture(){
 const state={value:{monitors:{farm:{enabled:false,intervalSec:300},pasture:{enabled:true,intervalSec:600}}},monitorDraft:{farm:{intervalSec:180,friendsEnabled:true},pasture:{intervalSec:600,friendsEnabled:true,feedEnabled:false}},monitorUpdating:{farm:false,pasture:false},monitorDirty:{farm:true,pasture:true}};
 const fields={farmMonitorToggle:{checked:true},pastureMonitorToggle:{checked:true}},requests=[],notices=[];let guards=0;
 const fn=source.slice(source.indexOf('  async function updateMonitor('),source.indexOf('  function bind()'));
 const update=vm.runInNewContext('('+fn.trim()+')',{state,$:s=>fields[s.slice(1)],monitorBlockReason:()=>{guards++;return '';},renderMonitorPanels(){},selectedSeed:()=>({seed:20002}),showNotice:m=>notices.push(m),post:async(path,payload)=>{requests.push({path,payload:JSON.parse(JSON.stringify(payload))});},load:async()=>{},render(){}});
 return{state,fields,requests,notices,update,guards:()=>guards};
}
test('farm and pasture controls live only in their own pages; priority settings have no timer',()=>{
 const farm=html.slice(html.indexOf('data-page="farm"'),html.indexOf('data-page="pasture"')),pasture=html.slice(html.indexOf('data-page="pasture"'),html.indexOf('data-page="settings"')),settings=html.slice(html.indexOf('data-page="settings"'),html.indexOf('</main>'));
 for(const[scope,page]of[['farm',farm],['pasture',pasture]])for(const suffix of['Toggle','Interval','Friends','Apply','Hint','Status'])assert.ok(page.includes('id="'+scope+'Monitor'+suffix+'"'));
 assert.ok(!settings.includes('MonitorToggle'));assert.ok(!html.includes('id="monitorToggle"'));assert.ok(!source.includes("post('/api/monitor',"));assert.ok(pasture.includes('id="pastureMonitorFeed"'));assert.ok(!farm.includes('pastureMonitorToggle'));
});
test('farm toggle posts only farm settings and leaves the pasture draft untouched',async()=>{
 const f=fixture();await f.update('farm',true);assert.deepEqual(f.requests,[{path:'/api/monitor/farm',payload:{enabled:true,intervalSec:180,friendsEnabled:true,seedId:20002}}]);assert.equal(f.state.monitorDirty.farm,false);assert.equal(f.state.monitorDirty.pasture,true);assert.equal(f.state.value.monitors.pasture.enabled,true);
});
test('pasture settings use independent endpoint, feed flag and interval without seed fields',async()=>{
 const f=fixture();await f.update('pasture');assert.deepEqual(f.requests,[{path:'/api/monitor/pasture',payload:{enabled:true,intervalSec:600,friendsEnabled:true,feedEnabled:false}}]);assert.equal(f.state.monitorDirty.farm,true);
});
test('stopping remains possible with an invalid draft and bypasses enable prerequisites',async()=>{
 const f=fixture();f.fields.pastureMonitorToggle.checked=false;f.state.monitorDraft.pasture.intervalSec=-1;await f.update('pasture',true);assert.deepEqual(f.requests,[{path:'/api/monitor/pasture',payload:{enabled:false}}]);assert.equal(f.guards(),0);
});
test('invalid interval does not send an update or touch another scene',async()=>{
 const f=fixture();f.state.monitorDraft.farm.intervalSec=1;await f.update('farm',true);assert.equal(f.requests.length,0);assert.equal(f.notices.length,1);assert.equal(f.state.monitorDirty.pasture,true);
});
test('switch remains clickable for validation feedback instead of silently disabling prerequisites',()=>{
 assert.ok(source.includes('toggle.disabled = busy;'));assert.ok(!source.includes('toggle.disabled = busy || (!saved.enabled && !!reason)'));assert.ok(source.includes('if (reason) { showNotice(reason, true); renderMonitorPanels(); return; }'));assert.ok(source.includes("toggle.setAttribute('aria-describedby', scope + 'MonitorHint')"));
});
