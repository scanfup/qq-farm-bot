import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Bridge } from '../tools/core.mjs';
import { seedMetadataExpression, aggregateItems, ownedSeeds } from './seed-inventory.mjs';
import { FriendsService } from './friends.mjs';
import { PreferencesStore, validatePreferences, orderByPriority } from './preferences.mjs';
import { NativeGameRpc } from './native-rpc.mjs';
import { PastureService, PASTURE_COMMANDS, PASTURE_READ_COMMANDS } from './pasture.mjs';
export { PASTURE_READ_COMMANDS } from './pasture.mjs';
import { decodeAllLandsReply, decodeBagReply, decodeFarmingReply, buildHarvest, buildPlant, buildRemovePlant, buildFarming, isEmpty, isMainLand, isDead } from '../tools/farm.mjs';
const PLANT = 'gamepb.plantpb.PlantService';
export const FRIEND_READ_COMMANDS = ['friends-refresh', 'friend-visit'];
export const COMMANDS = ['harvest', 'plant', 'plant-priority', 'care', 'care-self', 'remove-dead', 'friend-steal', 'friend-care', 'friend-insect', 'friend-weed', 'farm-manage', 'pasture-manage', ...PASTURE_COMMANDS];
const SCOPE_NAMES = new Set(['farm', 'pasture', 'system']);
function scopeFor(type) {
  if (type.startsWith('pasture-')) return 'pasture';
  return type.startsWith('friend-') || ['farm-manage','friends-refresh','refresh','care','care-self','harvest','plant','plant-priority','remove-dead'].includes(type) ? 'farm' : 'system';
}
function reconciliationScopeFor(type) { return type.startsWith('pasture-') ? 'pasture' : 'farm'; }
function retainJobs(jobs) {
  const counts = { farm: 0, pasture: 0, system: 0 };
  return jobs.filter(job => { job.scope = scopeFor(job.type); return ++counts[job.scope] <= 100; });
}
function scopesForPreference(input) {
  const scopes = [];
  if (['seedPriority','seedFallback'].some(key => input[key] !== undefined)) scopes.push('farm');
  if (['animalPriority','animalFallback','allowAnimalPurchase','maxAnimalSpendPerCycle'].some(key => input[key] !== undefined)) scopes.push('pasture');
  return scopes.length ? scopes : ['system'];
}
function businessRejected(error) {
  if (error.uncertain || error.cleanupFailed) return false;
  if (error.operationFailure) return true;
  const raw = error.code ?? error.gateway?.meta?.err;
  const code = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(code) && code > 0;
}
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function validSeed(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError('种子 ID 必须为正整数');
  return value;
}
export class FarmApp {
  constructor({ demo = false, bridge, dataDir = fileURLToPath(new URL('./data/', import.meta.url)), journal = true } = {}) {
    this.als = new AsyncLocalStorage();
    this.mode = demo ? 'demo' : 'live'; this.bridge = bridge || new Bridge(); this.selfGid = this.bridge.gid ?? 0;
    this.connection = { status: 'idle', port: this.bridge.port, contextId: null, lastError: null };
    this.snapshot = null; this.logs = []; this.jobs = []; this.ids = new Map();
    this.tail = Promise.resolve(); this.pending = 0; this.listeners = new Set();
    this.monitor = { enabled: false, intervalSec: 120, seedId: 20002, farmEnabled: true, pastureEnabled: false, farmFriendsEnabled: true, pastureFriendsEnabled: true, pastureFeedEnabled: false };
    this.reconcileScopes = new Set(); this._cycleRunning = false; this.monitorGeneration=0;
    this.monitors = {
      farm: { enabled: false, intervalSec: 300, friendsEnabled: true, seedId: 20002, running: false, lastRunAt: null, nextRunAt: null, lastError: null },
      pasture: { enabled: false, intervalSec: 300, friendsEnabled: true, feedEnabled: true, running: false, lastRunAt: null, nextRunAt: null, lastError: null },
    };
    this.sceneTimers = { farm: null, pasture: null };
    this.sceneGenerations = { farm: 0, pasture: 0 };
    this._sceneCycleRunning = null;
    this.sceneDue = { farm: false, pasture: false };
    this.stopped = false; this.needsReconcile = false;
    this.seedCatalog = new Map(Object.values(JSON.parse(readFileSync(new URL('../tools/seed-map.json', import.meta.url), 'utf8'))).map(({ seed, name }) => [seed, { seed, name, canPlant: true }]));
    this.seeds = [];
    this.inventory = { status: 'not-loaded', fetchedAt: null, error: null, source: null };
    this.preferenceStore = new PreferencesStore({ dataDir, demo, persist: journal });
    this.nativeRpc = new NativeGameRpc({ bridge: this.bridge, onWrite: () => { this._taskWriteAttempted = true; } });
    this.friendService = new FriendsService({
      demo, selfGid: this.selfGid,
      identityProvider: demo ? undefined : () => this.bridge.evaluate(`(() => {
        const model = globalThis.System?.get('chunks:///_virtual/GlobalData.ts')?.GlobalData?.selfModel;
        if (!model?.gid) return null;
        return { gid: Number(model.gid.toString()), name: String(model.name || ''), level: Number(model.level || 0) };
      })()`, { timeoutMs: 3000 }),
      log: message => this.log(message, 'farm'),
      bridge: { call: (service, method, body, timeoutMs) => service === PLANT && ['Harvest', 'Farming', 'PutInsects', 'PutWeeds'].includes(method)
        ? this.write(method, body, timeoutMs) : this.bridge.call(service, method, body, timeoutMs) },
    });
    this.pasture = new PastureService({ demo, rpc: (...args) => this.nativeRpc.call(...args),
      metadataProvider: () => this.nativeRpc.metadata(), identityProvider: () => this.nativeRpc.identity(),
      preferencesProvider: () => this.preferenceStore.state(), log: message => this.log(message, 'pasture') });
    if (journal) {
      mkdirSync(dataDir, { recursive: true }); this.journal = join(dataDir, demo ? 'demo-jobs.jsonl' : 'live-jobs.jsonl');
      if (existsSync(this.journal)) {
        const lines = readFileSync(this.journal, 'utf8').trim().split('\n');
        const unresolved=new Map();
        for (const line of lines) {
          if (!line) continue;
          try {
            const job=JSON.parse(line);
            if(job.kind==='reconcile') {
              if(!['farm','pasture'].includes(job.scope)) throw new Error('invalid scope');
              for(const[id,scope]of unresolved) if(scope===job.scope) unresolved.delete(id);
              continue;
            }
            if(typeof job.id!=='string'||typeof job.type!=='string') throw new Error('invalid job');
            job.scope = SCOPE_NAMES.has(job.scope) ? job.scope : scopeFor(job.type);
             this.ids.set(job.id,job);
            if(job.status==='uncertain') unresolved.set(job.id,reconciliationScopeFor(job.type)); else unresolved.delete(job.id);
          } catch { throw new Error('任务记录损坏，停止启动，避免丢失幂等记录'); }
        }
        for (const job of this.ids.values()) {
          if (['running', 'queued'].includes(job.status)) {
            job.status = 'uncertain'; job.error = '服务重启：任务结果需要核对，未自动重发';
            job.finishedAt = new Date().toISOString(); this.persist(job); unresolved.set(job.id,reconciliationScopeFor(job.type));
          }
        }
        for (const scope of unresolved.values()) this.reconcileScopes.add(scope);
        if (this.reconcileScopes.size) this.needsReconcile = true;
        this.jobs = retainJobs([...this.ids.values()].reverse());
      }
    }
    if (demo) {
      this.snapshot = { ...decodeAllLandsReply(readFileSync(new URL('../out/proto/AllLandsReply.bin', import.meta.url))), fetchedAt: new Date().toISOString(), source: '历史抓包样本，演示操作仅修改内存' };
      this.connection.status = 'demo';
      this.seeds = [20002, 20516].map(seed => ({ ...this.seedCatalog.get(seed), count: 99 }));
      this.inventory = { status: 'ready', fetchedAt: new Date().toISOString(), error: null, source: 'demo' };
    }
  }
  persist(job) { if (this.journal) appendFileSync(this.journal, JSON.stringify(job) + '\n'); }
  seedOptions() {
    const counts=new Map(this.seeds.map(seed=>[seed.seed,seed]));
    for (const id of this.preferenceStore.state().seedPriority) if (!counts.has(id)) counts.set(id,{...(this.seedCatalog.get(id)||{seed:id,name:String(id),canPlant:false}),count:0});
    return [...counts.values()];
  }
  state() { return { mode: this.mode, connection: this.connection, snapshot: this.snapshot, jobs: this.jobs, logs: this.logs, friendState: this.friendService.state(), pastureState: this.pasture.state(), preferences: this.preferenceStore.state(), seedOptions: this.seedOptions(), seeds: this.seeds, inventory: this.inventory, monitor: this.monitor, monitors: this.monitors, needsReconcile: this.needsReconcile }; }
  setPreferences(input) {
    if (this.pending || this._cycleRunning || this._sceneCycleRunning) throw new AppError('请等当前批量任务结束后再修改优先设置',409);
    let validated; try { validated=validatePreferences(input,this.preferenceStore.state()); } catch(error) { throw new AppError(error.message); }
    if (input.seedPriority && validated.seedPriority.some(id=>!this.seedCatalog.has(id))) throw new AppError('优先种子包含当前未识别的种子ID');
    if (input.animalPriority && validated.animalPriority.some(id=>!this.pasture.state().animals.some(a=>a.animalId===id))) throw new AppError('请先刷新牧场，选择有效的优先动物');
    let result; try { result=this.preferenceStore.update(validated); } catch(error) { throw new AppError(error.message); }
    if (input.seedPriority !== undefined || input.seedFallback !== undefined) this.log('种植优先设置已保存', 'farm');
     if (input.animalPriority !== undefined || input.animalFallback !== undefined || input.allowAnimalPurchase !== undefined || input.maxAnimalSpendPerCycle !== undefined) this.log('饲养优先设置已保存', 'pasture');
     if (scopesForPreference(input).includes('system')) this.log('优先设置已保存', 'system'); this.emit(); return result;
  }
  markReconciled(scope) {
    if(this.reconcileScopes.has(scope)) {
      if(this.journal) appendFileSync(this.journal,JSON.stringify({kind:'reconcile',scope,at:new Date().toISOString()})+'\n');
      this.reconcileScopes.delete(scope);
    }
    this.needsReconcile=this.reconcileScopes.size>0;
  }
  async refreshPasture() {
    try { await this.pasture.refresh(); return true; }
    catch(error) { this.log('牧场读取失败：'+error.message, 'pasture'); return false; }
  }
  emit() { for (const fn of this.listeners) fn(this.state()); }
  sanitize(message) { return String(message).replace(/(?:wss?|https?):\/\/[^\s"'<>]+/g, '[地址已隐藏]').slice(0, 800); }
  log(message, scope) {
    const selected = SCOPE_NAMES.has(scope) ? scope : (this.als.getStore()?.scope || 'system');
    this.logs.unshift({ at: new Date().toISOString(), message: this.sanitize(message), scope: selected });
    for (const name of SCOPE_NAMES) {
      const rows = this.logs.filter(item => item.scope === name);
      while (rows.length > 120) { const drop = rows.pop(); const index = this.logs.indexOf(drop); if (index >= 0) this.logs.splice(index, 1); }
    }
    if (this.logs.length > 360) this.logs.length = 360;
    this.emit();
  }
  submit(type, payload = {}, id = randomUUID()) {
    if (!['connect', 'refresh', ...FRIEND_READ_COMMANDS, ...PASTURE_READ_COMMANDS, ...COMMANDS].includes(type)) throw new AppError('不支持此操作');
    if (type === 'plant') validSeed(payload.seedId);
    if ((type === 'farm-manage' || type === 'pasture-manage') && (payload.gid != null || payload.maxFriends != null || payload.limit != null)) throw new AppError('一键管理必须扫描全部好友，不接受目标限制');
     if (payload.gid != null && ((!type.startsWith('friend-') && !type.startsWith('pasture-friends-') && type !== 'pasture-visit') || !Number.isSafeInteger(payload.gid) || payload.gid <= 0)) throw new AppError('好友 GID 必须为正整数');
    if (type === 'pasture-visit' && payload.gid == null) throw new AppError('查看牧场必须指定一个好友GID');
    if (payload.animalId != null && (!Number.isSafeInteger(payload.animalId)||payload.animalId<=0)) throw new AppError('动物ID必须为安全正整数');
    if (type === 'pasture-buy' && (!payload.animalId || !Number.isInteger(payload.count) || payload.count<1 || payload.count>20)) throw new AppError('请选择动物，购买数量应为1至20');
    if (payload.expectedUnitPrice != null && (!Number.isSafeInteger(payload.expectedUnitPrice)||payload.expectedUnitPrice<0)) throw new AppError('展示单价必须为非负安全整数');
    for (const key of ['limit','maxFriends']) if (payload[key] != null && (!Number.isInteger(payload[key])||payload[key]<1||payload[key]>100)) throw new AppError(key+'应为1至100');
    if (['friend-visit', 'friend-insect', 'friend-weed'].includes(type) && payload.gid == null) throw new AppError('此操作必须指定一个好友 GID');
    if (this.stopped) throw new AppError('服务正在关闭', 503);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new AppError('commandId 格式无效');
    const fingerprint = JSON.stringify({ type, seedId: payload.seedId ?? null, ...(type.startsWith('friend-') ? { gid: payload.gid ?? null } : {}), ...(type.startsWith('pasture-') ? { gid:payload.gid??null, animalId:payload.animalId??null, count:payload.count??null, limit:payload.limit??null, maxFriends:payload.maxFriends??null, expectedUnitPrice:payload.expectedUnitPrice??null } : {}) });
    const old = this.ids.get(id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError('commandId 已用于另一条命令', 409);
      return old;
    }
    if (type === 'connect' || type === 'refresh') {
      const inflight = this.jobs.find(j => j.type === type && ['queued', 'running'].includes(j.status));
      if (inflight) return inflight;
    }
    if (this.pending >= 20) throw new AppError('任务队列已满', 429);
    const job = { id, type, scope: scopeFor(type), fingerprint, status: 'queued', createdAt: new Date().toISOString() };
    this.persist(job); this.ids.set(id, job); this.jobs.unshift(job); this.jobs = retainJobs(this.jobs);
    this.pending++; this.emit();
    const sceneCycle = this.als.getStore()?.sceneCycle;
    const work = this.tail.then(() => this.als.run({ scope: job.scope, sceneCycle }, async () => {
      this._taskWriteAttempted = false;
      job.status = 'running'; this.persist(job); this.emit();
      try {
        if (!this.sceneContextActive()) { job.result = { skipped: true, cancelled: true, count: 0, message: '托管已停止或设置已变更，未发送操作' }; job.status = 'succeeded'; return; }
        if (type === 'connect') job.result = await this.connect();
        else if (type === 'refresh') { await this.ready(); job.result = await this.refresh({includePasture:true}); this.markReconciled('farm'); if(this.pasture.state().status==='ready') this.markReconciled('pasture'); if(this.needsReconcile) throw new AppError('牧场结果尚未核对成功，请刷新牧场后再操作',409); }
        else if (PASTURE_READ_COMMANDS.includes(type)) { await this.ready(); job.result = await this.pastureCommand(type,payload); if(type==='pasture-refresh') this.markReconciled('pasture'); }
        else if (type === 'friends-refresh') { await this.ready(); await this.friendService.refresh(); job.result = { count: this.friendService.state().friends.filter(f => !f.isSelf).length, message: '好友列表已更新' }; }
        else if (type === 'friend-visit') { await this.ready(); job.result = await this.friendCommand(type, payload); }
         else if (type === 'farm-manage' || type === 'pasture-manage') { if (this.needsReconcile) throw new AppError('上次操作结果待核对，请先刷新对应场景再执行一键务农',409); await this.ready(); job.result = await this.manageScene(type); }
        else {
          if (this.needsReconcile) throw new AppError('上次操作结果待核对，请先刷新土地再提交写操作', 409);
          await this.ready(); job.result = type.startsWith('pasture-') ? await this.pastureCommand(type,payload) : type.startsWith('friend-') ? await this.friendCommand(type, payload) : await this.command(type, payload);
        }
        job.status = 'succeeded';
      } catch (error) {
        if (this._taskWriteAttempted && !businessRejected(error) && !(error instanceof AppError)) error.uncertain = true;
        if (error.partialResult) job.result = error.partialResult;
        job.status = error.uncertain ? 'uncertain' : 'failed'; job.error = this.sanitize(error.message);
        if (error.uncertain) { this.needsReconcile = true; this.reconcileScopes.add(reconciliationScopeFor(type)); }
        this.stopMonitor();
        if (error.uncertain) {
          for (const scope of ['farm','pasture']) if (this.monitors[scope].enabled) {
            this.stopSceneMonitor(scope, scope === job.scope ? '写入结果待核对：' + job.error : '另一场景写入结果待核对，暂停托管以等待全局核对');
          }
        } else if (this.monitors[job.scope]?.enabled) this.stopSceneMonitor(job.scope, '操作失败：' + job.error);
        this.log(`${type}：${job.error}`);
      } finally {
        job.finishedAt = new Date().toISOString(); this.persist(job); this.pending--; this.emit();
        setImmediate(() => this.drainSceneDue());
      }
    }));
    this.tail = work.catch(error => {
      this.stopMonitor();
      for (const scope of ['farm','pasture']) if (this.monitors[scope].enabled) this.stopSceneMonitor(scope, '任务执行器异常，已暂停：' + this.sanitize(error.message));
      this.log('任务执行器异常：' + error.message, job.scope);
    });
    return job;
  }
  async connect() {
    if (this.mode === 'demo') { await this.refresh({includePasture:true}); return { message: '演示模式，不连接小游戏' }; }
    this.connection.status = 'connecting';
    this.friendService.invalidate(); this.pasture.invalidate();
    this.seeds = []; this.inventory = { status: 'not-loaded', fetchedAt: null, error: null, source: null };
    this.emit();
    try {
      await this.bridge.ensure({ onLog: message => this.log(message, 'system') });
      await this.friendService.ensureHome();
      this.connection = { status: 'connecting', port: this.bridge.port, contextId: this.bridge.ctxId, lastError: null };
      await this.refresh({includePasture:true}); this.connection.status = 'ready'; this.markReconciled('farm'); if(this.pasture.state().status==='ready') this.markReconciled('pasture'); this.log('CDP 已就绪，真实农场与牧场状态已读取', 'system');
      return { message: '连接成功' };
    } catch (error) {
      this.connection.status = 'error'; this.connection.contextId = null; this.connection.lastError = this.sanitize(error.message);
      this.bridge.status = 'error'; throw error;
    }
  }
  async ready() {
    if (this.mode === 'demo') return;
    if (this.connection.status !== 'ready' || !(await this.bridge.ping()).ok) await this.connect();
    else await this.friendService.ensureHome();
  }
  async refreshInventory() {
    if (this.mode === 'demo') return;
    try {
      const reply = await this.bridge.call('gamepb.itempb.ItemService', 'Bag', Buffer.alloc(0));
      const bag = decodeBagReply(reply.body);
      if (bag.empty) throw new Error('背包回包为空或结构缺失');
      const totals = aggregateItems(bag.items);
      let metadata, source, warning;
      try {
        const live = await this.bridge.evaluate(seedMetadataExpression([...totals.keys()]));
        if (!live?.available || !Array.isArray(live.seeds)) throw new Error('物品配置尚未加载');
        metadata = live.seeds; source = '游戏实时配置';
      } catch {
        metadata = [...this.seedCatalog.values()]; source = '本地目录';
        warning = '实时物品配置暂不可用，当前仅显示本地目录可识别的背包种子';
      }
      for (const item of metadata) this.seedCatalog.set(item.seed, item);
      this.seeds = ownedSeeds(totals, metadata);
      this.inventory = { status: 'ready', fetchedAt: new Date().toISOString(), error: null, source, ...(warning ? { warning } : {}) };
    } catch (error) {
      this.seeds = [];
      this.inventory = { status: 'error', fetchedAt: null, error: this.sanitize(error.message), source: null };
    }
  }
  async refreshFriends() {
    try { await this.friendService.refresh(); this.selfGid = this.friendService.selfGid; }
    catch (error) { this.log('读取好友失败：' + error.message, 'farm'); }
  }
  async refresh({includePasture=false}={}) {
    if (this.mode === 'demo') {
      this.snapshot.fetchedAt = new Date().toISOString();
      this.friendService.updateLimits(this.snapshot.limits); await this.refreshFriends(); if(includePasture) await this.refreshPasture();
      this.emit(); return { count: this.snapshot.lands.length };
    }
    try {
      const reply = await this.bridge.call(PLANT, 'AllLands', Buffer.alloc(0));
      const data = decodeAllLandsReply(reply.body);
      if (data.empty || !data.lands.length) throw new Error('土地回包为空，请先在小游戏内回到自己的农场');
      this.snapshot = { ...data, fetchedAt: new Date().toISOString(), source: '小游戏 CDP' };
      this.friendService.updateLimits(data.limits);
      await this.refreshInventory(); await this.refreshFriends(); if(includePasture) await this.refreshPasture();
      this.connection.lastError = null; this.emit(); return { count: data.lands.length };
    } catch (error) { this.connection.lastError = '读取土地失败，旧快照仅供参考'; this.emit(); throw error; }
  }
  async write(method, body, timeoutMs = 15000) {
    this._taskWriteAttempted = true;
    try { return await this.bridge.call(PLANT, method, body, timeoutMs); }
    catch (error) { if (!businessRejected(error)) error.uncertain = true; throw error; }
  }
  async manageScene(type) {
    if (!['farm-manage','pasture-manage'].includes(type)) throw new AppError('不支持此场景管理');
    if (this.needsReconcile) throw new AppError('上次操作结果待核对，请先刷新对应场景再执行一键务农',409);
    const scope = type === 'farm-manage' ? 'farm' : 'pasture';
    if (scope === 'farm') await this.refresh();
    const steps = scope === 'farm'
      ? [['care', () => this.careAll(true)], ['friend-steal', () => this.friendCommand('friend-steal', {})]]
      : ['pasture-clean','pasture-feed','pasture-produce','pasture-harvest','pasture-place','pasture-friends-clean','pasture-friends-steal'].map(step => [step, () => this.pastureCommand(step,{})]);
    const names = { care:'照料自家与全部好友', 'friend-steal':'全部好友偷菜', 'pasture-clean':'清理自家牧场', 'pasture-feed':'库存补牧草', 'pasture-produce':'开始生产', 'pasture-harvest':'成熟收取', 'pasture-place':'按优先级补栏', 'pasture-friends-clean':'全部好友牧场清理', 'pasture-friends-steal':'全部好友牧场摘取' };
    const scene = scope === 'farm' ? '农场' : '牧场';
    const result = { scope, steps: [], count: 0, changed: false, attemptedWrites: 0, spent: 0, errors: [] };
    const accumulate = (value, step) => {
      result.count += Number(value?.count || 0);
      result.changed ||= !!value?.changed;
      result.attemptedWrites += Number(value?.attemptedWrites || 0);
      result.spent += Number(value?.spent || 0);
      result.errors.push(...(value?.errors || []).map(error => ({ ...error, step })));
    };
    for (const [step, run] of steps) {
      if (!this.sceneContextActive()) { result.cancelled = true; result.message = scene + '托管已停止或设置变更，保留已确认结果'; return result; }
      this.log(scene + '一键务农：开始' + names[step], scope);
      try {
        const value = await this.als.run({ ...this.als.getStore(), scope }, run);
        accumulate(value, step); result.steps.push({ type: step, result: value });
        this.log(scene + '一键务农：' + (value?.message || '完成' + names[step]), scope);
      } catch (error) {
        accumulate(error.partialResult, step);
        result.steps.push({ type: step, result: error.partialResult || null, error: this.sanitize(error.message) });
        result.errors.push({ type: step, message: this.sanitize(error.message) });
        result.message = scene + '一键务农停止于' + names[step] + '，此前及本步已确认 ' + result.count + ' 项';
        error.partialResult = { ...result, failedStep: step }; throw error;
      }
    }
    result.message = scene + '一键务农完成，共 ' + result.steps.length + ' 步，确认 ' + result.count + ' 项' + (result.errors.length ? '，' + result.errors.length + ' 项未完成' : '');
    return result;
  }
  async pastureCommand(type,payload={}) {
    try {
      if(type==='pasture-refresh') { await this.pasture.refresh(); return {count:this.pasture.state().ranches.length,message:'牧场、库存、场景2好友已更新'}; }
      await this.pasture.refresh();
      return await this.pasture.run(type,payload);
    } finally { this.emit(); }
  }
  async friendCommand(type, payload) {
    await this.refresh();
    try {
      const result = await this.friendService.run(type, payload.gid);
      await this.refresh();
      return result;
    } finally { this.emit(); }
  }
  async careAll(includeFriends=true) {
    const targets = this.snapshot.lands.filter(l => l.unlocked && isMainLand(l) && l.plant?.id && !isDead(l) && (l.plant.needCare || l.plant.weedOwners.length || l.plant.insectOwners.length));
    let selfCount = 0, selfRewards = 0;
    if (this.mode === 'demo') {
      for (const land of targets) Object.assign(land.plant, { needCare: false, needWater: false, needWeed: false, needInsect: false, weedOwners: [], insectOwners: [] });
      selfCount = targets.length;
    } else if (targets.length) {
      try {
        const reply = await this.write('Farming', buildFarming(targets.map(l => l.id), 0, false), 25000);
        const result = decodeFarmingReply(reply.body);
        if (result.empty) throw new Error('务农回包为空，请核对实际结果');
        selfCount = result.results.length;
        selfRewards = result.results.reduce((sum, item) => sum + (item.reward?.count || 0), 0);
      } catch (error) { if (error.code !== 1001057) throw error; }
    }
    let friends;
    try { friends = includeFriends && this.sceneContextActive() ? await this.friendService.run('friend-care') : {count:0,attemptedWrites:0,changed:false,rewardTotal:0,errors:[]}; }
    catch (error) {
      const partial = error.partialResult || {};
      error.partialResult = { ...partial, selfCount, friendCount: partial.count || 0, count: selfCount + (partial.count || 0), changed: selfCount > 0 || !!partial.changed };
      throw error;
    }
    await this.refresh();
    return { ...friends, selfCount, friendCount: friends.count, count: selfCount + friends.count,
      attemptedWrites: friends.attemptedWrites + (this.mode === 'live' && targets.length ? 1 : 0),
      changed: selfCount > 0 || friends.changed, rewardTotal: selfRewards + friends.rewardTotal,
      message: `务农完成：自家 ${selfCount} 块，好友 ${friends.count} 条${friends.errors.length ? `；${friends.errors.length} 项未完成，详情见日志` : ''}` };
  }
  async command(type, payload) {
    await this.refresh();
    if (type === 'care' || type === 'care-self') return this.careAll(type === 'care');
    if (type === 'plant-priority') {
      const prefs=this.preferenceStore.state();
      const selected=orderByPriority(this.seeds,prefs.seedPriority,{idKey:'seed',fallback:prefs.seedFallback,available:s=>s.count>0&&s.canPlant})[0];
      if (!selected) return {count:0,skipped:true,message:prefs.seedPriority.length?'优先种子库存不足，保留所选优先级，本轮跳过种植':'尚未设置优先种子，请先保存优先顺序'};
      const choices=orderByPriority(this.seeds,prefs.seedPriority,{idKey:'seed',fallback:prefs.seedFallback,available:s=>s.count>0&&s.canPlant});
      const result={count:0,plantings:[],message:'已按保存的种子优先顺序种植'};
      try { for(const choice of choices) {
        if(!this.snapshot.lands.some(l=>l.unlocked&&isMainLand(l)&&isEmpty(l)))break;
        const item=await this.command('plant',{seedId:choice.seed});
        result.count+=item.count; if(item.count) result.plantings.push({seedId:choice.seed,name:choice.name,count:item.count});
      } } catch(error) { error.partialResult=result;throw error; }
      return result;
    }
    const lands = this.snapshot.lands.filter(l => l.unlocked && isMainLand(l));
    let targets;
    if (type === 'harvest') targets = lands.filter(l => l.plant?.id && l.plant.currentPhase !== 7 && l.plant.isRipe);
    if (type === 'plant') targets = lands.filter(isEmpty);
    if (type === 'remove-dead') targets = lands.filter(isDead);
    if (!targets.length) return { count: 0, message: '没有符合条件的主地块' };
    const seedId = type === 'plant' ? validSeed(payload.seedId) : null;
    if (type === 'plant') {
      if (this.inventory.status !== 'ready') throw new AppError('种子库存读取失败，请刷新重试：' + (this.inventory.error || '尚未加载'));
      const selected = this.seeds.find(item => item.seed === seedId);
      if (!selected?.count) {
        const name = this.seedCatalog.get(seedId)?.name || String(seedId);
        const available = this.seeds.filter(item => item.canPlant).slice(0, 4).map(item => `${item.name}×${item.count}`).join('、');
        throw new AppError(`所选种子「${name}」(ID ${seedId})库存为0。${available ? '当前有库存：' + available + '；请重新选择。' : '当前未识别到有库存的可种植种子。'}`);
      }
      if (!selected.canPlant) throw new AppError('所选种子不在当前农场种植配置中');
      targets = targets.slice(0, selected.count);
    }
    const ids = targets.map(l => l.id);
    if (this.mode === 'demo') {
      for (const l of targets) {
        if (type === 'remove-dead') l.plant = null;
        if (type === 'harvest') Object.assign(l.plant, { currentPhase: 7, lastPhaseName: 'DEAD', isRipe: false });
        if (type === 'care') Object.assign(l.plant, { needCare: false, needWater: false, needWeed: false, needInsect: false, weedOwners: [], insectOwners: [] });
        if (type === 'plant') l.plant = { id: seedId, name: this.seeds.find(s => s.seed === seedId)?.name || String(seedId), currentPhase: 1, isRipe: false, ripeAt: Math.floor(Date.now()/1000)+60, weedOwners: [], insectOwners: [] };
      }
      if (type === 'plant') {
        this.seeds.find(item => item.seed === seedId).count -= ids.length;
        this.seeds = this.seeds.filter(item => item.count > 0);
        this.inventory.fetchedAt = new Date().toISOString();
      }
      this.emit(); return { count: ids.length, message: '演示操作完成，没有访问真实账号' };
    }
    let method, body;
    if (type === 'harvest') { method = 'Harvest'; body = buildHarvest(ids); }
    if (type === 'plant') { method = 'Plant'; body = buildPlant(seedId, ids, true); }
    if (type === 'remove-dead') { method = 'RemovePlant'; body = buildRemovePlant(ids); }
    await this.write(method, body);
    try { await this.refresh(); }
    catch { const error = new Error('请求已返回，但刷新失败，请核对实际土地状态'); error.uncertain = true; throw error; }
    this.log(`${type} 完成，目标 ${ids.length} 块地`);
    return { count: ids.length, landIds: ids, message: '游戏已返回成功，快照已刷新' };
  }
  setMonitor(input) {
    const {enabled,intervalSec=this.monitor.intervalSec,seedId=this.monitor.seedId}=input;
    if (typeof enabled!=='boolean'||!Number.isInteger(intervalSec)||intervalSec<60||intervalSec>3600) throw new AppError('周期应为60至3600秒，enabled必须为布尔值');
    const scopes={};
    for(const key of ['farmEnabled','pastureEnabled','farmFriendsEnabled','pastureFriendsEnabled','pastureFeedEnabled']) {
      scopes[key]=input[key]??this.monitor[key]; if(typeof scopes[key]!=='boolean') throw new AppError(key+'必须为布尔值');
    }
    if(enabled) {
      if (Object.values(this.monitors).some(m => m.enabled) || this._sceneCycleRunning) throw new AppError('请先关闭独立场景托管，并等待当前周期结束',409);
      if(!scopes.farmEnabled&&!scopes.pastureEnabled) throw new AppError('请至少选择农场或牧场管理');
      if(this.needsReconcile) throw new AppError('请先刷新核对上次操作结果',409);
      const prefs=this.preferenceStore.state();
      if(scopes.farmEnabled) {
        if(this.inventory.status!=='ready') throw new AppError('请先成功刷新种子库存');
        if(!prefs.seedPriority.length&&!prefs.seedFallback) {
          validSeed(seedId); if(!this.seeds.some(item=>item.seed===seedId&&item.count>0&&item.canPlant)) throw new AppError('所选种子无库存或不能种植，请重新选择');
        }
      }
      if(scopes.pastureEnabled&&this.pasture.state().status!=='ready') throw new AppError('请先成功刷新牧场');
    }
    this.stopMonitor(); this.monitor={enabled,intervalSec,seedId,...scopes};
    if(enabled) { this.timer=setInterval(()=>{ this.runMonitorCycle().catch(error=>{this.stopMonitor();this.log(error.message, 'system');}); },intervalSec*1000);this.timer.unref(); }
    this.log(enabled?'定时批量管理已开启，周期'+intervalSec+'秒；使用已保存优先级与所选管理范围':'自动任务已停止', 'system');this.emit();return this.monitor;
  }
  async runMonitorCycle() {
    if(this.pending||this.stopped||!this.monitor.enabled||this._cycleRunning||this._sceneCycleRunning||Object.values(this.monitors).some(m=>m.enabled)) return {skipped:true};
    this._cycleRunning=true;
    try {
      const generation=this.monitorGeneration,m={...this.monitor},prefs=this.preferenceStore.state(),steps=[];
      if(m.farmEnabled) {
        steps.push(['harvest',{}],['remove-dead',{}],[(prefs.seedPriority.length||prefs.seedFallback)?'plant-priority':'plant',{seedId:m.seedId}]);
        if(m.farmFriendsEnabled) steps.push(['friend-steal',{}]);
        steps.push([m.farmFriendsEnabled?'care':'care-self',{}]);
      }
      if(m.pastureEnabled) {
        steps.push(['pasture-clean',{}],['pasture-produce',{}],['pasture-harvest',{}]);
        if(m.pastureFeedEnabled) steps.push(['pasture-feed',{}]);
        steps.push(['pasture-place',{}]);
        if(m.pastureFriendsEnabled) steps.push(['pasture-friends-clean',{}],['pasture-friends-steal',{}]);
      }
      for(const[type,payload]of steps) {
        if(!this.monitor.enabled||this.stopped||this.monitorGeneration!==generation)break;
        const job=this.submit(type,payload);await this.tail;
        if(job.status!=='succeeded')break;
      }
      return {completed:true};
    } finally {this._cycleRunning=false;}
  }
  sceneContextActive() {
    const cycle = this.als.getStore()?.sceneCycle;
    return !cycle || (!this.stopped && this.monitors[cycle.scope].enabled && this.sceneGenerations[cycle.scope] === cycle.generation);
  }
  sceneName(scope) { return scope === 'farm' ? '农场' : '牧场'; }
  validateScene(scope) { if (!['farm','pasture'].includes(scope)) throw new AppError('场景不存在',404); }
  setSceneMonitor(scope, input) {
    this.validateScene(scope);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('托管设置必须为对象');
    const fields = ['enabled','intervalSec','friendsEnabled',scope === 'farm' ? 'seedId' : 'feedEnabled'];
    if (Object.keys(input).some(key => !fields.includes(key))) throw new AppError('包含不属于当前场景的设置字段');
    if (typeof input.enabled !== 'boolean') throw new AppError('enabled必须为布尔值');
    // Stopping always uses the last validated configuration, regardless of stale form drafts.
    if (!input.enabled) {
      this.stopSceneMonitor(scope);
      const config = { ...this.monitors[scope], ...input };
      const valid = Number.isInteger(config.intervalSec) && config.intervalSec >= 60 && config.intervalSec <= 3600
        && typeof config.friendsEnabled === 'boolean'
        && (scope === 'farm' ? Number.isSafeInteger(config.seedId) && config.seedId > 0 : typeof config.feedEnabled === 'boolean');
      if (valid && Object.keys(input).some(key => key !== 'enabled')) {
        Object.assign(this.monitors[scope], config);
        this.log(this.sceneName(scope) + '托管设置已保存（未开启）', scope);
      }
      this.emit(); return this.monitors[scope];
    }
    if (this.stopped) throw new AppError('服务正在关闭',503);
    const previous = this.monitors[scope];
    const next = { ...previous, ...input, lastError: null };
    if (!Number.isInteger(next.intervalSec) || next.intervalSec < 60 || next.intervalSec > 3600) throw new AppError('周期应为60至3600秒');
    if (typeof next.friendsEnabled !== 'boolean') throw new AppError('friendsEnabled必须为布尔值');
    if (scope === 'pasture' && typeof next.feedEnabled !== 'boolean') throw new AppError('feedEnabled必须为布尔值');
    if (scope === 'farm' && input.seedId !== undefined) validSeed(input.seedId);
    if (this.monitor.enabled || this._cycleRunning) throw new AppError('请先关闭旧版定时管理，并等待当前周期结束',409);
    if (this.needsReconcile) throw new AppError('请先刷新核对上次操作结果',409);
    if (!['ready','demo'].includes(this.connection.status)) throw new AppError('请先连接游戏运行时',409);
    if (scope === 'farm') {
      if (this.inventory.status !== 'ready' || !this.snapshot?.fetchedAt) throw new AppError('请先成功刷新农场及种子库存');
      const prefs = this.preferenceStore.state();
      if (!prefs.seedPriority.length && !prefs.seedFallback) {
        validSeed(next.seedId);
        if (!this.seeds.some(seed => seed.seed === next.seedId && seed.count > 0 && seed.canPlant === true)) throw new AppError('所选种子无库存或不能种植，请重新选择');
      }
      const friends = this.friendService.state();
      if (next.friendsEnabled && (friends.status !== 'ready' || !friends.identitySource || !Number.isSafeInteger(friends.selfGid) || friends.selfGid <= 0)) throw new AppError('请先刷新农场好友并确认账号身份');
    } else {
      const pasture = this.pasture.state();
      if (pasture.status !== 'ready' || pasture.inventoryStatus !== 'ready' || !pasture.fetchedAt) throw new AppError('请先成功刷新牧场与动物库存');
      if (next.friendsEnabled && (pasture.friends?.status !== 'ready' || !Number.isSafeInteger(pasture.selfGid) || pasture.selfGid <= 0 || pasture.account?.gid !== pasture.selfGid)) throw new AppError('请先刷新牧场好友并确认账号身份');
    }
    clearInterval(this.sceneTimers[scope]);
    const generation = ++this.sceneGenerations[scope];
    this.sceneDue[scope] = false; next.waiting = false;
    next.nextRunAt = new Date(Date.now() + next.intervalSec * 1000).toISOString();
    this.monitors[scope] = next;
    this.sceneTimers[scope] = setInterval(() => {
      if (this.sceneGenerations[scope] !== generation) return;
      void this.runSceneMonitorCycle(scope).catch(error => this.stopSceneMonitor(scope, '托管执行异常：' + this.sanitize(error.message)));
    }, next.intervalSec * 1000);
    this.sceneTimers[scope].unref();
    this.log(this.sceneName(scope) + '托管' + (previous.enabled ? '设置已更新' : '已开启') + '，周期' + next.intervalSec + '秒；首次到期执行', scope);
    this.emit(); return next;
  }
  stopSceneMonitor(scope, reason = null) {
    this.validateScene(scope);
    clearInterval(this.sceneTimers[scope]); this.sceneTimers[scope] = null;
    this.sceneGenerations[scope]++;
    const monitor = this.monitors[scope];
    monitor.enabled = false; monitor.nextRunAt = null; monitor.waiting = false; this.sceneDue[scope] = false;
    if (reason) monitor.lastError = this.sanitize(reason);
    this.log(this.sceneName(scope) + (reason ? '托管已暂停：' + monitor.lastError : '托管已关闭，已发出的当前操作将完成'), scope);
    this.emit(); return monitor;
  }
  async runSceneMonitorCycle(scope) {
    this.validateScene(scope);
    const monitor = this.monitors[scope];
    if (!monitor.enabled || this.stopped) return { skipped: true, reason: 'disabled' };
    monitor.nextRunAt = new Date(Date.now() + monitor.intervalSec * 1000).toISOString();
    if (this.pending || this._cycleRunning || this._sceneCycleRunning || this.monitor.enabled) {
      this.sceneDue[scope] = true; monitor.waiting = true;
      this.log(this.sceneName(scope) + '托管：当前忙碌，本轮等待队列空闲后执行，不重复堆积', scope);
      return { skipped: true, waiting: true, reason: 'busy' };
    }
    if (this.needsReconcile) {
      this.stopSceneMonitor(scope, '上次操作结果待核对，本轮未执行');
      return { skipped: true, reason: 'reconcile' };
    }
    const generation = this.sceneGenerations[scope], config = { ...monitor }, prefs = this.preferenceStore.state();
    this.sceneDue[scope] = false; monitor.waiting = false;
    this._sceneCycleRunning = scope; monitor.running = true;
    monitor.lastRunAt = new Date().toISOString(); monitor.lastError = null;
    const active = () => !this.stopped && this.monitors[scope].enabled && this.sceneGenerations[scope] === generation;
    const steps = [];
    if (scope === 'farm') {
      steps.push(['harvest',{}], ['remove-dead',{}]);
      steps.push((prefs.seedPriority.length || prefs.seedFallback) ? ['plant-priority',{}] : ['plant',{seedId:config.seedId}]);
      steps.push([config.friendsEnabled ? 'farm-manage' : 'care-self',{}]);
    } else {
      steps.push(['pasture-clean',{}]);
      if (config.feedEnabled) steps.push(['pasture-feed',{}]);
      steps.push(['pasture-produce',{}],['pasture-harvest',{}],['pasture-place',{}]);
      if (config.friendsEnabled) steps.push(['pasture-friends-clean',{}],['pasture-friends-steal',{}]);
    }
    const jobs = []; let failed = false;
    this.log(this.sceneName(scope) + '托管：本轮开始', scope);
    try {
      for (const [type,payload] of steps) {
        if (!active()) break;
        // submit owns the same queue as manual work; never execute RPCs concurrently.
        const job = this.als.run({ scope, sceneCycle: { scope, generation } }, () => this.submit(type,payload)); jobs.push(job);
        await this.tail;
        if (job.status !== 'succeeded') { failed = true; break; }
      }
      const completed = !failed && active() && jobs.length === steps.length;
      this.log(this.sceneName(scope) + '托管：本轮' + (completed ? '完成' : failed ? '因操作失败结束' : '已停止后续步骤'), scope);
      return { completed, cancelled: !failed && !completed, jobs };
    } catch (error) {
      this.stopSceneMonitor(scope, '托管异常：' + this.sanitize(error.message));
      return { completed: false, error: this.sanitize(error.message), jobs };
    } finally {
      this.monitors[scope].running = false; this._sceneCycleRunning = null; this.emit();
      setImmediate(() => this.drainSceneDue(scope === 'farm' ? 'pasture' : 'farm'));
    }
  }
  drainSceneDue(preferred = 'farm') {
    if (this.stopped || this.pending || this._cycleRunning || this._sceneCycleRunning || this.monitor.enabled) return;
    const scope = [preferred, preferred === 'farm' ? 'pasture' : 'farm'].find(scene => this.sceneDue[scene] && this.monitors[scene].enabled);
    if (!scope) return;
    this.sceneDue[scope] = false;
    void this.runSceneMonitorCycle(scope).catch(error => this.stopSceneMonitor(scope, '托管执行异常：' + this.sanitize(error.message)));
  }
  stopMonitor() { clearInterval(this.timer); this.monitorGeneration++; this.monitor.enabled = false; this.emit(); }
  async close() {
    this.stopped = true; this.stopMonitor();
    for (const scope of ['farm','pasture']) this.stopSceneMonitor(scope);
    await this.tail; this.bridge.close();
  }
}
