import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('./public/navigation.js',import.meta.url),'utf8');
function fixture({hash='',mobile=false,storageError=false,saved='false'}={}){
  let document;
  class Element {
    constructor(dataset={}){this.dataset=dataset;this.attrs={};this.handlers={};this.hidden=false;this.isConnected=true;this.classes=new Set();this.classList={toggle:(key,value)=>{if(value===undefined)value=!this.classes.has(key);if(value)this.classes.add(key);else this.classes.delete(key);},contains:key=>this.classes.has(key)};}
    setAttribute(key,value){this.attrs[key]=value;} removeAttribute(key){delete this.attrs[key];}
    addEventListener(key,fn){this.handlers[key]=fn;} fire(key,event={}){this.handlers[key]?.(event);}
    focus(){document.activeElement=this;}getClientRects(){return[{}];}
    querySelectorAll(){return controls;}
  }
  const ids=Object.fromEntries(['activitySidebar','activityToggle','activityClose','activityBackdrop','landsDisclosure','pageMain'].map(id=>[id,new Element()]));
  const pages=['farm','pasture','settings'].map(page=>new Element({page}));
  const links=pages.map(p=>new Element({route:p.dataset.page}));const headings=Object.fromEntries(pages.map(p=>[p.dataset.page,new Element()]));
  const controls=[ids.activityClose,new Element()];const stored=new Map([['qqfarm.ui.landsExpanded',saved]]);
  document={body:new Element(),activeElement:ids.activityToggle,querySelector(selector){if(selector[0]==='#')return ids[selector.slice(1)];const match=/data-page="([^"]+)"/.exec(selector);return match?headings[match[1]]:null;},querySelectorAll(selector){return selector==='[data-page]'?pages:links;},handlers:{},addEventListener(key,fn){this.handlers[key]=fn;}};
  const media={matches:mobile,addEventListener(key,fn){this.handler=fn;}};
  const window={location:{hash,pathname:'/',search:'?view=1'},history:{replaceState(a,b,url){window.location.hash=new URL(url,'http://localhost').hash;window.replaced=url;}},matchMedia:()=>media,handlers:{},addEventListener(key,fn){this.handlers[key]=fn;},scrollTo(){window.scrolled=true;},localStorage:{getItem(key){if(storageError)throw Error('disabled');return stored.get(key);},setItem(key,value){if(storageError)throw Error('disabled');stored.set(key,value);}}};
  vm.runInNewContext(script,{window,document});
  return{window,document,ids,pages,links,media,stored,controls,headings,navigate(hash){window.location.hash=hash;window.handlers.hashchange();}};
}
test('empty and invalid routes use farm without requesting game operations',()=>{
  for(const hash of ['', '#/unknown', '#/pasture/extra']){const f=fixture({hash});assert.equal(f.window.location.hash,'#/farm');assert.deepEqual(f.pages.filter(p=>!p.hidden).map(p=>p.dataset.page),['farm']);assert.equal(f.links[0].attrs['aria-current'],'page');assert.equal(f.window.replaced,'/?view=1#/farm');}
});
test('direct links and hash history show one page, reset main scroll and preserve land state',()=>{
  const f=fixture({hash:'#/pasture',saved:'true'});assert.equal(f.pages[1].hidden,false);assert.equal(f.document.title,'牧场 · QQ 农场控制台');f.ids.landsDisclosure.open=false;f.ids.pageMain.scrollTop=500;f.navigate('#/settings');assert.equal(f.pages[2].hidden,false);assert.equal(f.pages[1].hidden,true);assert.equal(f.links[1].attrs['aria-current'],undefined);assert.equal(f.document.activeElement,f.headings.settings);f.navigate('#/farm');assert.equal(f.ids.landsDisclosure.open,false);assert.equal(f.ids.pageMain.scrollTop,0);assert.equal(f.window.scrolled,true);
});
test('land details default collapsed and preferences survive disabled storage',()=>{
  const f=fixture();assert.equal(f.ids.landsDisclosure.open,false);f.ids.landsDisclosure.open=true;f.ids.landsDisclosure.fire('toggle');assert.equal(f.stored.get('qqfarm.ui.landsExpanded'),'true');const blocked=fixture({storageError:true});assert.doesNotThrow(()=>blocked.ids.landsDisclosure.fire('toggle'));
});
test('mobile log drawer opens, traps focus, closes with Escape, and restores focus',()=>{
  const f=fixture({mobile:true});assert.equal(f.ids.activitySidebar.inert,true);f.ids.activityToggle.fire('click');assert.equal(f.ids.activitySidebar.inert,false);assert.equal(f.document.body.classList.contains('activity-open'),true);assert.equal(f.ids.activitySidebar.attrs['aria-modal'],'true');assert.equal(f.ids.activityBackdrop.hidden,false);assert.equal(f.document.activeElement,f.ids.activityClose);
  let prevented=false;f.document.handlers.keydown({key:'Tab',shiftKey:true,preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(f.document.activeElement,f.controls.at(-1));f.document.handlers.keydown({key:'Escape',preventDefault(){}});assert.equal(f.ids.activitySidebar.inert,true);assert.equal(f.document.activeElement,f.ids.activityToggle);assert.equal(f.ids.activityToggle.attrs['aria-expanded'],'false');
});
test('desktop log is always available and changing route or viewport releases the mobile overlay',()=>{
  const f=fixture({mobile:true});f.ids.activityToggle.fire('click');f.navigate('#/pasture');assert.equal(f.document.body.classList.contains('activity-open'),false);f.ids.activityToggle.fire('click');f.media.matches=false;f.media.handler();assert.equal(f.ids.activitySidebar.inert,false);assert.equal(f.ids.activitySidebar.attrs['aria-hidden'],undefined);assert.equal(f.ids.activityBackdrop.hidden,true);assert.equal(f.document.body.classList.contains('activity-open'),false);
});
test('navigation asset and hash-route shell are served without adding game endpoints',async()=>{
  const{FarmApp}=await import('./service.mjs');const{createServer}=await import('./server.mjs');const app=new FarmApp({demo:true,journal:false}),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  try{for(const path of ['/','/navigation.js','/style.css']){const res=await fetch(base+path);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.ok((await res.text()).length>500);}assert.equal((await fetch(base+'/pasture')).status,404);assert.equal(app.jobs.length,0);assert.equal(app.monitor.enabled,false);}
  finally{server.closeStreams();await new Promise(r=>server.close(r));await app.close();}
});

test('legacy friends bookmarks redirect to the combined farm page',()=>{const f=fixture({hash:'#/friends'});assert.equal(f.window.location.hash,'#/farm');assert.equal(f.document.title,'农场 · QQ 农场控制台');assert.deepEqual(f.pages.filter(p=>!p.hidden).map(p=>p.dataset.page),['farm']);});
