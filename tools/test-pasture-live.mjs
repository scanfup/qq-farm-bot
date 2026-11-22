import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:3210',path='out/management/live-acceptance.json';
const mode=process.argv.includes('--timed')?'timed':process.argv.includes('--manual')?'manual':'preflight';
if(mode!=='preflight'&&!process.argv.includes('--write'))throw Error('真实写入验收需要显式 --write');
let report=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{startedAt:new Date().toISOString(),actions:[]};
const save=()=>writeFileSync(path,JSON.stringify(report,null,2));
async function get(){const r=await fetch(base+'/api/state');if(!r.ok)throw Error('读取state失败');return r.json();}
async function post(route,payload){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Farm-Request':'1'},body:JSON.stringify(payload)});const data=await r.json();if(!r.ok)throw Error(`${route}: ${data.error}`);return data;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function metrics(s){const p=s.pastureState;return{at:new Date().toISOString(),gid:p.selfGid,status:p.status,needsReconcile:s.needsReconcile,monitor:s.monitor,ranches:p.ranches.map(r=>({id:r.ranch_inst_id,capacity:r.capacity,count:r.animal_count,animals:(r.animals||[]).map(a=>({id:a.animal_inst_id,animalId:a.animal_id,stage:a.stage,canHarvest:!!a.can_harvest})),grass:r.grass?.amount,hazards:(r.hazards||[]).length})),stocks:p.animals.filter(a=>a.count>0).map(a=>({animalId:a.animalId,name:a.name,count:a.count})),balances:p.balances,grassStock:p.grassStock,feedMachines:p.feedMachines,friends:p.friends.items.filter(f=>!f.isSelf).length};}
async function command(type,payload={}){const start=Date.now();const j=await post('/api/commands',{type,...payload,commandId:randomUUID()});while(Date.now()-start<45000){const state=await get();const job=state.jobs.find(v=>v.id===j.id);if(job&&!['queued','running'].includes(job.status)){report.actions.push({type,payload,status:job.status,result:job.result,error:job.error});save();console.log(JSON.stringify({type,status:job.status,result:job.result,error:job.error}));if(job.status!=='succeeded')throw Error(type+': '+job.status+' '+job.error);if(state.needsReconcile)throw Error('需要核对，停止后续写入');return{state,job};}await pause(200);}throw Error(type+'等待超时，不重发');}
async function ensure(){let s=await get();if(s.connection.status!=='ready'){const j=await post('/api/connect',{});const deadline=Date.now()+30000;while(Date.now()<deadline){s=await get();const job=s.jobs.find(v=>v.id===j.id);if(job?.status==='failed')throw Error(job.error);if(s.connection.status==='ready')break;await pause(200);}}assert.equal(s.connection.status,'ready');if(s.pastureState.status!=='ready'){await command('pasture-refresh');s=await get();}assert.equal(s.pastureState.status,'ready',s.pastureState.error||'牧场尚未就绪');if(s.needsReconcile)throw Error('先核对已有不确定结果，不进行验收写入');assert.equal(Number(s.pastureState.selfGid),1229136306);return s;}
async function restore(){await post('/api/monitor',{...report.originalMonitor,enabled:false});if(report.originalPreferences)await post('/api/preferences',report.originalPreferences);}
try{
  const initial=await ensure();
  if(mode==='preflight'){
    report={startedAt:new Date().toISOString(),originalPreferences:initial.preferences,originalMonitor:initial.monitor,actions:[],before:metrics(initial)};save();console.log(JSON.stringify({preflight:report.before}));
  }else{
    if(!report.originalPreferences)throw Error('先执行--preflight保存原设置');
    await post('/api/monitor',{enabled:false});
    if(mode==='manual'){
      const chicken=initial.pastureState.animals.find(a=>a.animalId===60001);assert.equal(chicken?.unlocked,true);assert.ok(Number.isSafeInteger(Number(chicken.price))&&Number(chicken.price)>=0&&Number(chicken.price)<=2,'验收只授权最多2金券的一只鸡');
      await command('pasture-buy',{animalId:60001,count:1,expectedUnitPrice:chicken.price});
      await command('pasture-produce',{limit:1});
      await command('pasture-harvest',{limit:1});
      await post('/api/preferences',{animalPriority:[60001],animalFallback:false,allowAnimalPurchase:false,maxAnimalSpendPerCycle:0});
      await command('pasture-place',{limit:1});
      await command('pasture-feed',{limit:1});
      await command('pasture-friends-clean');
      await command('pasture-friends-steal');
      report.afterManual=metrics(await get());save();await restore();
    }else{
      await post('/api/preferences',{animalPriority:[60003],animalFallback:false,allowAnimalPurchase:false,maxAnimalSpendPerCycle:0});
      const started=Date.now();report.timerStartedAt=new Date(started).toISOString();save();
      await post('/api/monitor',{enabled:true,intervalSec:60,farmEnabled:false,pastureEnabled:true,farmFriendsEnabled:false,pastureFriendsEnabled:true,pastureFeedEnabled:true});
      let completed=false;
      while(Date.now()-started<110000){const s=await get();const jobs=s.jobs.filter(j=>Date.parse(j.createdAt)>=started);const bad=jobs.find(j=>['failed','uncertain'].includes(j.status));if(bad)throw Error('定时任务失败: '+bad.type+' '+bad.error);const end=jobs.find(j=>j.type==='pasture-friends-steal'&&j.status==='succeeded');if(end){report.previousTimerJobs=report.timerJobs;report.timerJobs=jobs.filter(j=>j.type.startsWith('pasture-')).map(j=>({type:j.type,status:j.status,result:j.result}));report.afterTimed=metrics(s);completed=true;break;}await pause(400);}
      if(!completed)throw Error('未观察到一轮完整定时任务');
      await restore();report.final=metrics(await get());report.completedAt=new Date().toISOString();if(report.error){report.previousErrors=[...(report.previousErrors||[]),report.error];delete report.error;}save();console.log(JSON.stringify({timedCyclePassed:true,timerJobs:report.timerJobs,final:report.final}));
    }
  }
}catch(error){report.error={at:new Date().toISOString(),message:error.message};save();if(mode!=='preflight')try{await restore();}catch(e){console.error('停止/还原需检查：'+e.message);}throw error;}
