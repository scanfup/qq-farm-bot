import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./public/app.js',import.meta.url),'utf8');
const start=source.indexOf('  function activityEntries('),end=source.indexOf('  function renderActivity(',start);
assert.ok(start>=0&&end>start);
const entries=vm.runInNewContext('('+source.slice(start,end).trim()+')');
test('jobs and runtime logs share a newest-first timeline using task completion time',()=>{
  const jobs=[{id:'old',createdAt:'2026-11-20T01:00:00Z',finishedAt:'2026-11-20T03:00:00Z',status:'succeeded'},{id:'new',createdAt:'2026-11-20T04:00:00Z',status:'running'}];
  const logs=[{at:'2026-11-20T02:00:00Z',message:'before completion'},{at:'2026-11-20T05:00:00Z',message:'latest'}];
  assert.deepEqual(Array.from(entries(jobs,logs),e=>e.kind==='job'?e.job.id:e.log.message),['latest','new','old','before completion']);
});
test('failed, uncertain, pending and completed jobs are not hidden from the shared stream',()=>{
  const jobs=['failed','uncertain','queued','running','succeeded'].map((status,id)=>({id:String(id),status,createdAt:'2026-11-20T01:00:00Z'}));
  const result=entries(jobs,[]);assert.equal(result.length,5);assert.deepEqual(Array.from(result,e=>e.job.status),jobs.map(j=>j.status));assert.equal(entries([],[]).length,0);
});
test('missing timestamps sort last, each task stays one record as its status changes',()=>{
  const job={id:'same',createdAt:'2026-11-20T01:00:00Z',status:'queued'};assert.equal(entries([job],[{message:'unknown time'}]).at(-1).kind,'log');job.status='succeeded';job.finishedAt='2026-11-20T02:00:00Z';assert.equal(entries([job],[]).length,1);assert.equal(entries([job],[])[0].job.status,'succeeded');
});
test('one visible shared box replaces the separate collapsed task panel',()=>{
  const html=readFileSync(new URL('./public/index.html',import.meta.url),'utf8');assert.equal([...html.matchAll(/id="logsList"/g)].length,1);assert.ok(!html.includes('id="jobsList"'));assert.ok(!html.includes('tasks-panel'));assert.match(html,/<h2 id="activityTitle">农场任务与日志<\/h2>/);assert.match(source,/renderActivity\(s.jobs \|\| \[\], s.logs \|\| \[\]\)/);
  const css=readFileSync(new URL('./public/style.css',import.meta.url),'utf8');assert.match(css,/grid-template-rows:\s*minmax\(0,1fr\)/);assert.match(css,/\.activity-sidebar\{height:auto;min-height:0/);
});

test('farm and pasture jobs and logs are strictly separated, including legacy jobs',()=>{
  const jobs=[{id:'farm',type:'farm-manage'},{id:'pasture',type:'pasture-manage'},{id:'old-farm',type:'friend-steal'},{id:'old-pasture',type:'pasture-harvest'},{id:'connect',type:'connect'}];
  const logs=[{scope:'farm',message:'farm-only'},{scope:'pasture',message:'pasture-only'},{scope:'system',message:'system-only'},{message:'legacy-unscoped'}];
  assert.deepEqual(Array.from(entries(jobs,logs,'farm'),e=>e.job?.id||e.log.message),['farm','old-farm','farm-only']);
  assert.deepEqual(Array.from(entries(jobs,logs,'pasture'),e=>e.job?.id||e.log.message),['pasture','old-pasture','pasture-only']);
  assert.deepEqual(Array.from(entries(jobs,logs,'system'),e=>e.job?.id||e.log.message),['connect','system-only','legacy-unscoped']);
});
test('explicit recorded scope takes priority over command-name inference',()=>{
  assert.equal(entries([{id:'x',type:'pasture-harvest',scope:'farm'}],[],'pasture').length,0);assert.equal(entries([{id:'x',type:'pasture-harvest',scope:'farm'}],[],'farm').length,1);
});
test('changing scene switches the shared box immediately and preserves separate scroll positions',()=>{
  const state={};const window={location:{hash:'#/farm'}};
  const element=()=>({children:[],scrollTop:0,append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);},set textContent(value){this.text=value;this.children=[];this.scrollTop=0;},get textContent(){return this.text;}});
  const elements={logsList:element(),activityTitle:element(),jobCount:element()};
  const rendererSource=source.slice(source.indexOf('  function renderActivity('),source.indexOf('  async function request('));
  const render=vm.runInNewContext('('+rendererSource.trim()+')',{state,window,$:selector=>elements[selector.slice(1)],activityEntries:entries,node:(tag,cls,text)=>({...element(),text}),fmtTime:()=>'',labels:{},statusLabels:{succeeded:'已完成'}});
  const jobs=[{id:'farm',type:'farm-manage',status:'succeeded'},{id:'pasture',type:'pasture-manage',status:'succeeded'}],logs=[{scope:'farm',message:'farm only'},{scope:'pasture',message:'pasture only'}];
  render(jobs,logs);assert.equal(elements.activityTitle.textContent,'农场任务与日志');assert.equal(elements.logsList.children.length,2);assert.equal(elements.jobCount.textContent,'1 条任务');elements.logsList.scrollTop=120;
  window.location.hash='#/pasture';render(jobs,logs);assert.equal(elements.activityTitle.textContent,'牧场任务与日志');assert.equal(state.activityScroll.farm,120);assert.equal(elements.logsList.scrollTop,0);elements.logsList.scrollTop=75;
  window.location.hash='#/farm';render(jobs,logs);assert.equal(elements.logsList.scrollTop,120);assert.equal(state.activityScroll.pasture,75);
});
test('partial success exposes business rejection names, codes and reasons inline',()=>{
 const el=()=>({children:[],scrollTop:0,append(...nodes){this.children.push(...nodes);},appendChild(node){this.children.push(node);},set textContent(value){this.text=value;this.children=[];},get textContent(){return this.text;}}),elements={logsList:el(),activityTitle:el(),jobCount:el()};
 const rendererSource=source.slice(source.indexOf('  function renderActivity('),source.indexOf('  async function request('));
 const render=vm.runInNewContext('('+rendererSource.trim()+')',{state:{},window:{location:{hash:'#/farm'}},$:s=>elements[s.slice(1)],activityEntries:entries,node:(tag,cls,text)=>({...el(),text,className:cls}),fmtTime:()=>'',labels:{},statusLabels:{succeeded:'已完成'}});
 render([{type:'farm-manage',status:'succeeded',result:{count:12,message:'部分结果',errors:[{name:'好友甲',code:1001021,message:'作物未成熟'}]}}],[]);
 const flatten=node=>[node,...node.children.flatMap(flatten)],nodes=flatten(elements.logsList);assert.ok(nodes.some(n=>n.text==='部分完成'));assert.ok(nodes.some(n=>n.className==='activity-error-detail'&&n.text.includes('好友甲')&&n.text.includes('1001021')&&n.text.includes('作物未成熟')));
});
