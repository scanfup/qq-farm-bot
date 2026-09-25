// QQ 农场挂机 TUI
// 用法: node tools/tui.mjs [--port 62000] [--gid 1274359435] [--yes]
import readline from 'node:readline';
import { Bridge, PHASE, sleep } from './core.mjs';
import {
  parse, fields, field, num, str, repeatedInts, decodeAllLandsReply, decodeBagReply,
  decodeShopReply, decodeBuyReply, decodeFarmingReply,
  buildHarvest, buildPlant, buildPutItem, buildVisitEnter, buildVisitLeave, buildRemovePlant,
  buildBuyGoods, buildShopInfo, buildFarming,
} from './farm.mjs';

// ---------- 样式 ----------
const C = {
  brand: '\x1b[38;5;214m', dim: '\x1b[38;5;244m', ok: '\x1b[38;5;114m',
  warn: '\x1b[38;5;203m', info: '\x1b[38;5;81m', rst: '\x1b[0m', b: '\x1b[1m',
};
const SVC = {
  plant: 'gamepb.plantpb.PlantService',
  friend: 'gamepb.friendpb.FriendService',
  visit: 'gamepb.visitpb.VisitService',
  shop: 'gamepb.shoppb.ShopService',
  item: 'gamepb.itempb.ItemService',
};
const SEED_SHOP_ID = 2;   // 1=道具 2=种子 3=宠物
const ICON = { steal: '🥕', insect: '🐛', weed: '🌿' };
const dispW = (s) => { let n = 0; for (const ch of String(s)) n += /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1; return n; };
const pad = (s, w) => { s = String(s); const d = w - dispW(s); return d > 0 ? s + ' '.repeat(d) : s; };
const cut = (s, w) => {
  s = String(s); let out = '', n = 0;
  for (const ch of s) { const cw = dispW(ch); if (n + cw > w) break; out += ch; n += cw; }
  return out;
};
const hhmmss = (ms) => {
  const t = Math.floor(ms / 1000);
  return [Math.floor(t / 3600), Math.floor(t % 3600 / 60), t % 60].map(x => String(x).padStart(2, '0')).join(':');
};
const now = () => new Date().toTimeString().slice(0, 8);

// ---------- TUI ----------
class Tui {
  constructor(bridge, opts = {}) {
    this.b = bridge;
    this.gid = opts.gid || 0;
    this.headless = !!opts.headless;
    this.logs = [];
    this.lands = [];
    this.limits = [];
    this.friends = [];
    this.seedId = opts.seedId || 20002;
    this.autoMonitor = !!opts.monitor;   // 就绪后自动开启挂机
    this.monitor = false;
    this.monitorTimer = null;
    this.busy = false;
    this.quit = false;
    this.startedAt = Date.now();
    this.lastRefresh = 0;
    this.w = process.stdout.columns || 100;
    this.h = process.stdout.rows || 30;
    this.focus = 'farm';
    this.cmdMode = false;      // / 指令输入模式
    this.cmdBuf = '';
    this.cmdHistory = [];
  }

  log(msg, kind = 'info') {
    this.logs.push({ t: now(), m: String(msg), kind });
    if (this.logs.length > 200) this.logs.shift();
    if (this.headless) {
      const tag = kind === 'err' ? 'ERR ' : kind === 'ok' ? 'OK  ' : kind === 'task' ? '..  ' : '    ';
      console.log(`[${now()}] ${tag}${msg}`);
      return;
    }
    // 交互模式：立即刷新屏幕，让挂机动作实时可见（100ms 节流，避免狂刷）
    if (!this._started) return;
    const t = Date.now();
    if (t - (this._lastRender || 0) > 100) {
      this._lastRender = t;
      this.render();
    } else if (!this._renderPending) {
      this._renderPending = true;
      setTimeout(() => {
        this._renderPending = false;
        this._lastRender = Date.now();
        if (this._started && !this.quit) this.render();
      }, 100);
    }
  }

  // ---------- 渲染 ----------
  render() {
    const W = this.w, H = this.h;
    const out = [];
    const line = (s = '') => out.push(cut(s, W - 2).padEnd(W - 2));

    // 顶栏
    const st = this.b.status === 'ready' ? `${C.ok}● ready${C.rst}` : `${C.warn}● ${this.b.status}${C.rst}`;
    const acc = this.acct ? `${C.b}${this.acct.name || '?'}${C.rst} lv${this.acct.level || '?'}` : `${C.dim}未登录数据${C.rst}`;
    line(`${C.brand}${C.b} QQ 农场挂机 ${C.rst}${C.dim}CDP ${this.b.port}${C.rst} ${st}  gid ${C.info}${this.gid || '-'}${C.rst}`);
    line(`${C.dim}连接${C.rst} st=${this.conn?.st ?? '-'} cseq=${this.conn?.cseq ?? '-'}  ${acc}  ${C.dim}运行${C.rst} ${hhmmss(Date.now() - this.startedAt)}  ${C.dim}自愈${C.rst} ${this.b.recoveries}  ${C.dim}挂机${C.rst} ${this.monitor ? C.ok + 'ON' + C.rst : C.dim + 'off' + C.rst}`);
    line();

    // 分栏
    const colA = Math.floor((W - 3) * 0.48);
    const colB = W - 3 - colA;

    // 我的农场
    const farmLines = this.renderFarm(colA);
    const friendLines = this.renderFriends(colB);
    const rows = Math.max(farmLines.length, friendLines.length);
    for (let i = 0; i < rows; i++) {
      line(`${pad(farmLines[i] || '', colA)} ${C.dim}│${C.rst} ${friendLines[i] || ''}`);
    }

    line();
    // 日志
    const logBudget = Math.max(4, H - rows - 8);
    const logs = this.logs.slice(-logBudget);
    for (let i = 0; i < logBudget; i++) {
      const l = logs[i];
      if (!l) { line(); continue; }
      const col = l.kind === 'ok' ? C.ok : l.kind === 'err' ? C.warn : l.kind === 'task' ? C.info : C.dim;
      line(`${C.dim}${l.t}${C.rst} ${col}${l.m}${C.rst}`);
    }

    // 底栏
    line();
    if (this.cmdMode) {
      line(`${C.brand}指令 ${C.rst}${this.cmdBuf}${C.info}_${C.rst}  ${C.dim}(Enter 执行 · Esc 取消 · 输入 /帮助 看全部)${C.rst}`);
    } else {
      line(`${C.brand}[/]${C.rst}指令(中文)  ${C.brand}[a]${C.rst}四件套 ${C.brand}[m]${C.rst}挂机 ${C.brand}[h]${C.rst}收获 ${C.brand}[p]${C.rst}种植 ${C.brand}[d]${C.rst}务农 ${C.brand}[s]${C.rst}偷菜 ${C.brand}[r]${C.rst}自愈 ${C.brand}[q]${C.rst}退出`);
      line(`${C.dim}挂机只需登录成功即可运行：收获 → 种植 → 偷菜 → 务农。撒虫撒草有额度限制，请用 /撒虫 <gid>、/撒草 <gid> 手动执行${C.rst}`);
    }
    if (this.busy) line(`${C.info}${this.busy}${C.rst}`);

    process.stdout.write('\x1b[H' + out.map(l => l).join('\n') + '\x1b[J');
  }

  renderFarm(w) {
    const L = [];
    const unlocked = this.lands.filter(l => l.unlocked);
    const ripe = unlocked.filter(l => l.masterLandId === 0 && l.plant && l.plant.isRipe);
    const empty = unlocked.filter(l => l.masterLandId === 0 && (!l.plant || !l.plant.id));
    const dead = unlocked.filter(l => l.masterLandId === 0 && l.plant && l.plant.id && l.plant.currentPhase === 7);
    L.push(`${C.b}我的农场${C.rst} ${C.dim}已解锁 ${unlocked.length}${C.rst}  ${C.ok}成熟 ${ripe.length}${C.rst} ${C.info}空地 ${empty.length}${C.rst} ${C.dim}枯死 ${dead.length}${C.rst}`);
    L.push(`${C.dim}${'─'.repeat(Math.max(0, w - 2))}${C.rst}`);
    const maxShow = Math.max(3, Math.floor((this.h - 14) / 1) - 2);
    for (const l of unlocked.slice(0, maxShow)) {
      const p = l.plant;
      const isSlave = l.masterLandId !== 0;
      let tag, color;
      if (isSlave) { tag = '副产→' + l.masterLandId; color = C.dim; }
      else if (!p || !p.id) { tag = '空地'; color = C.info; }
      else if (p.isRipe) { tag = '成熟'; color = C.ok; }
      else if (p.currentPhase === 7) { tag = '枯死'; color = C.warn; }
      else { tag = PHASE[p.currentPhase] || String(p.currentPhase); color = C.dim; }
      const nm = isSlave ? '' : (p && p.name ? cut(p.name, 12) : '-');
      const extra = (!isSlave && p && p.id) ? `${C.dim}草${p.weedOwners.length} 虫${p.insectOwners.length} 果${p.leftFruitNum}${C.rst}` : '';
      L.push(` ${pad('地' + l.id, 5)} ${color}${pad(tag, 14)}${C.rst}${pad(nm, 14)}${extra}`);
    }
    if (unlocked.length > maxShow) L.push(`${C.dim}  ... 还有 ${unlocked.length - maxShow} 块${C.rst}`);
    return L;
  }

  renderFriends(w) {
    const L = [];
    L.push(`${C.b}好友${C.rst} ${C.dim}共 ${this.friends.length}${C.rst}`);
    L.push(`${C.dim}${'─'.repeat(Math.max(0, w - 2))}${C.rst}`);
    for (const f of this.friends.slice(0, 14)) {
      const isSelf = f.gid === this.gid;
      const tags = [];
      if (f.stealable > 0) tags.push(`${C.ok}偷${f.stealable}${C.rst}`);
      if (f.weed > 0) tags.push(`${C.dim}草${f.weed}${C.rst}`);
      if (f.insect > 0) tags.push(`${C.dim}虫${f.insect}${C.rst}`);
      const name = cut(f.name || '?', 10);
      L.push(` ${C.dim}${String(f.gid).padStart(10)}${C.rst} ${pad(name, 12)}${C.dim}lv${pad(f.level, 3)}${C.rst} ${tags.join(' ')}${isSelf ? ` ${C.brand}(自己)${C.rst}` : ''}`);
    }
    if (!this.friends.length) L.push(`${C.dim}  (未加载，按 r 刷新)${C.rst}`);
    return L;
  }

  // ---------- 数据刷新 ----------
  async refresh() {
    const rep = await this.b.call(SVC.plant, 'AllLands', Buffer.alloc(0));
    const d = decodeAllLandsReply(rep.body);
    this.lands = d.lands;
    this.limits = d.limits;
    this.lastRefresh = Date.now();

    const fr = await this.b.call(SVC.friend, 'GetAll', Buffer.alloc(0));
    const r = parse(fr.body);
    this.friends = fields(r, 1).map(bs => {
      const f = parse(bs);
      const pl = fields(f, 9)[0];
      let weed = 0, insect = 0, stealable = 0;
      if (pl) {
        const p = parse(pl);
        stealable = num(p, 6); weed = num(p, 8); insect = num(p, 9);
      }
      return { gid: num(f, 1), name: str(f, 3), level: num(f, 6), weed, insect, stealable };
    });
    // 从好友列表里认出自己，取昵称与等级
    const me = this.friends.find(f => f.gid === this.gid);
    if (me) this.acct = { name: me.name, level: me.level };
  }

  // ---------- 任务 ----------
  async guard(name, fn) {
    if (this.busy) { this.log(`上一个任务未结束，跳过 ${name}`, 'err'); return; }
    this.busy = name + ' 执行中...';
    const t0 = Date.now();
    try {
      await fn();
    } catch (e) {
      this.log(`${name} 失败: ${e.message}`, 'err');
      if (/CDP|__bot|netInst|上下文/.test(e.message)) {
        this.log('检测到桥接异常，尝试自愈...', 'err');
        try {
          await this.b.ensure({ onLog: (m) => this.log(m) });
          this.log('自愈成功', 'ok');
        } catch (e2) { this.log('自愈失败: ' + e2.message, 'err'); }
      }
    } finally {
      this.busy = false;
      this.log(`${name} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'task');
    }
  }

  async taskHarvest() {
    await this.guard('一键收获', async () => {
      const d = decodeAllLandsReply((await this.b.call(SVC.plant, 'AllLands', Buffer.alloc(0))).body);
      const ripe = d.lands.filter(l => l.unlocked && l.masterLandId === 0 && l.plant && l.plant.id && l.plant.isRipe).map(l => l.id);
      if (!ripe.length) { this.log('没有成熟地块', 'task'); return; }
      this.log(`🌾 收获 ${ripe.length} 块: ${ripe.join(',')}`, 'task');
      const r = await this.b.call(SVC.plant, 'Harvest', buildHarvest(ripe, this.gid, true));
      const lim = fields(parse(r.body), 4).map(bs => { const l = parse(bs); return `id${num(l, 1)}:${num(l, 2)}`; });
      this.log(`✅ 收获成功 ${r.body.length}B ${lim.join(' ')}`, 'ok');
      await this.refresh();
    });
  }

  async taskClear() {
    await this.guard('一键铲除', async () => {
      const d = decodeAllLandsReply((await this.b.call(SVC.plant, 'AllLands', Buffer.alloc(0))).body);
      const dead = d.lands.filter(l => l.unlocked && l.masterLandId === 0 && l.plant && l.plant.id && l.plant.currentPhase === 7).map(l => l.id);
      if (!dead.length) { this.log('没有枯死地块', 'task'); return; }
      this.log(`🪓 铲除 ${dead.length} 块枯株: ${dead.join(',')}`, 'task');
      const r = await this.b.call(SVC.plant, 'RemovePlant', buildRemovePlant(dead), 20000);
      this.log(`✅ 铲除成功 ${r.body ? r.body.length : 0}B`, 'ok');
      await this.refresh();
    });
  }

  async taskPlant() {
    await this.guard('一键种植', async () => {
      let d = decodeAllLandsReply((await this.b.call(SVC.plant, 'AllLands', Buffer.alloc(0))).body);
      // 收获后地块处于 DEAD（枯株），必须铲除才会变回空地
      const dead = d.lands.filter(l => l.unlocked && l.masterLandId === 0 && l.plant && l.plant.id && l.plant.currentPhase === 7).map(l => l.id);
      if (dead.length) {
        this.log(`🪓 先铲除 ${dead.length} 块枯株: ${dead.join(',')}`, 'task');
        const rc = await this.b.call(SVC.plant, 'RemovePlant', buildRemovePlant(dead), 20000);
        this.log(`✅ 铲除成功 ${rc.body ? rc.body.length : 0}B`, 'ok');
        await sleep(400);
        d = decodeAllLandsReply((await this.b.call(SVC.plant, 'AllLands', Buffer.alloc(0))).body);
      }
      const targets = d.lands.filter(l => l.unlocked && l.masterLandId === 0 && (!l.plant || !l.plant.id)).map(l => l.id);
      if (!targets.length) { this.log('没有空地', 'task'); return; }

      // 种子余量检查：背包 count 决定本次最多能种几块
      let avail = 0;
      const bagCount = async () => {
        const bag = await this.b.call(SVC.item, 'Bag', Buffer.alloc(0));
        const bd = decodeBagReply(bag.body);
        const seed = bd.items.find(i => i.id === this.seedId);
        return seed ? seed.count : 0;
      };
      try { avail = await bagCount(); this.seedCount = avail; }
      catch (e) { this.log('查背包失败: ' + e.message, 'err'); return; }

      // 种子不足 → 自动购买（金币足够时）
      if (avail < targets.length) {
        const need = targets.length - avail;
        this.log(`💰 种子不足（背包 ${avail}/需 ${targets.length}），自动购买 ${need} 个`, 'task');
        try {
          const g = await this.findSeedGoods();
          if (!g) { this.log(`种子商店无 ${this.seedId} 或无购买权限`, 'err'); }
          else {
            const r = await this.b.call(SVC.shop, 'BuyGoods', buildBuyGoods(g.id, need, g.price), 20000);
            const d = decodeBuyReply(r.body);
            const gold = d.cost.find(x => x.id === 1001);
            this.log(`💰 购买成功：得 ${d.get.map(x => `${x.id}×${x.count}`).join(' ')}，耗金币 ${gold ? gold.count : '?'}`, 'ok');
            avail = await bagCount();
            this.seedCount = avail;
          }
        } catch (e) { this.log('自动购买失败: ' + e.message, 'err'); }
      }

      if (avail <= 0) { this.log(`种子 ${this.seedId} 仍不足，跳过种植`, 'err'); return; }
      const use = targets.slice(0, avail);
      if (use.length < targets.length) this.log(`种子仅 ${avail} 个，本轮只种 ${use.length}/${targets.length} 块`, 'err');

      this.log(`🌱 种植 ${use.length} 块: ${use.join(',')} (seed ${this.seedId}，余 ${avail})`, 'task');
      const r = await this.b.call(SVC.plant, 'Plant', buildPlant(this.seedId, use, true), 20000);   // auto_slave：副产地自动跟随
      this.log(`✅ 种植成功 ${r.body ? r.body.length : 0}B`, 'ok');
      await this.refresh();
    });
  }

  // 在种子商店里找目标种子的商品条目
  async findSeedGoods() {
    const r = await this.b.call(SVC.shop, 'ShopInfo', buildShopInfo(SEED_SHOP_ID));
    const goods = decodeShopReply(r.body);
    this.shopGoods = goods;
    return goods.find(g => g.itemId === this.seedId && g.unlocked) || null;
  }

  async taskBuySeed(num) {
    await this.guard(`购买种子 x${num}`, async () => {
      const g = await this.findSeedGoods();
      if (!g) { this.log(`种子商店里没有可购买的 ${this.seedId}`, 'err'); return; }
      this.log(`商品 id=${g.id} 单价 ${g.price} 金币 × ${num}`, 'task');
      const r = await this.b.call(SVC.shop, 'BuyGoods', buildBuyGoods(g.id, num, g.price), 20000);
      const d = decodeBuyReply(r.body);
      this.log(`💰 购买成功：得 ${d.get.map(x => `${x.id}×${x.count}`).join(' ')}，耗 ${d.cost.map(x => `${x.id}×${x.count}`).join(' ')}`, 'ok');
    });
  }

  async taskFriends() {
    await this.guard('刷新好友', async () => { await this.refresh(); this.log(`好友 ${this.friends.length} 个`, 'ok'); });
  }

  async taskRaid(mode, onlyGid) {
    const label = mode === 'insect' ? '撒虫' : mode === 'weed' ? '撒草' : '偷菜';
    const method = mode === 'insect' ? 'PutInsects' : mode === 'weed' ? 'PutWeeds' : 'Harvest';
    await this.guard(`一键${label}`, async () => {
      if (!this.friends.length) await this.refresh();
      // 偷菜以好友摘要的 steal_plant_num 作为门控（服务端算好的权威可偷数），
      // Visit 回包里的 PlantInfo.stealable 是作物品种属性，恒为 true，不能用来判断。
      let targets = this.friends.filter(f => f.gid !== this.gid && (mode === 'steal' ? f.stealable > 0 : true));
      if (onlyGid) targets = targets.filter(f => f.gid === Number(onlyGid));
      if (!targets.length) { this.log(`${label}：没有可操作的好友（均无可偷/无目标）`, 'task'); return; }

      // 放虫/放草共用额度 id10003（每日上限 100），按剩余额度动态分配到每个好友，
      // 避免前几个好友就把当日额度烧光。
      let perFriend = Number(process.env.MAX_PER_FRIEND || 6);
      if (mode !== 'steal') {
        const d = decodeAllLandsReply((await this.b.call(SVC.plant, 'AllLands', Buffer.alloc(0))).body);
        const lim = d.limits.find(l => l.id === 10003);
        const remain = lim ? Math.max(0, lim.dayLimit - lim.dayTimes) : 100;
        if (remain <= 0) { this.log(`${label}：今日放虫/放草额度已用尽 (10003)`, 'err'); return; }
        const fair = Math.max(1, Math.floor(remain / targets.length));
        perFriend = Math.max(1, Math.min(perFriend, fair));
        this.log(`📊 ${label}：剩余额度 ${remain} / ${targets.length} 个好友，每人 ${perFriend} 块`, 'task');
      }
      let landTotal = 0, okTotal = 0;
      for (const f of targets) {
        try {
          const er = await this.b.call(SVC.visit, 'Enter', buildVisitEnter(f.gid));
          const rep = parse(er.body);
          const lands = fields(rep, 2);
          const cand = [];
          for (const bs of lands) {
            const li = parse(bs);
            if (num(li, 2) === 0) continue;          // 未解锁
            if (num(li, 13) !== 0) continue;         // ★ 副产地不可单独操作
            const id = num(li, 1);
            const pb = fields(li, 10)[0];
            if (!pb) continue;
            const p = parse(pb);
            const ph = fields(p, 4);
            const phase = ph.length ? num(parse(ph[ph.length - 1]), 1) : 0;
            const weedN = repeatedInts(p, 12).length;    // PlantInfo.weed_owners   非空=已有草
            const insectN = repeatedInts(p, 13).length;  // PlantInfo.insect_owners 非空=已有虫
            const stealable = num(p, 16) !== 0;          // PlantInfo.stealable
            const leftFruit = num(p, 18);                // PlantInfo.left_fruit_num
            if (mode === 'steal') {
              if (stealable && leftFruit > 0) cand.push({ id, phase });
            } else if (mode === 'insect') {
              // ★ 已有虫的地块不能再撒虫（服务端回 1001037，错误文案有误导性）
              if (insectN === 0 && phase !== 7 && phase !== 0) cand.push({ id, phase });
            } else {
              // ★ 已有草的地块不能再撒草
              if (weedN === 0 && phase !== 7 && phase !== 0) cand.push({ id, phase });
            }
          }
          if (!cand.length) { await this.b.call(SVC.visit, 'Leave', buildVisitLeave(f.gid)).catch(() => { }); continue; }
          // 生长中的优先（成功率更高），成熟的后补
          cand.sort((a, b) => (a.phase === 6 ? 1 : 0) - (b.phase === 6 ? 1 : 0));
          const pick = cand.slice(0, perFriend).map(x => x.id);
          landTotal += pick.length;
          if (mode === 'steal') {
            const r = await this.b.call(SVC.plant, 'Harvest', buildHarvest(pick, f.gid, true));
            okTotal += pick.length;
            this.log(`🥕 偷 ${f.name} ${pick.length}块 → ${r.body ? r.body.length : 0}B`, 'ok');
          } else {
            let ok = 0, stopped = false;
            for (const lid of pick) {
              try {
                await this.b.call(SVC.plant, method, buildPutItem(f.gid, [lid]));
                ok++; okTotal++;
              } catch (e) {
                const code = e.code || e.gateway?.meta?.err || 0;
                if (code === 1001046) { this.log(`${label} 今日额度已满，全局停止`, 'err'); stopped = true; break; }
                if (code === 1001036 || code === 1001037) continue;   // 单地块拒绝，继续下一个
              }
              await sleep(120);
            }
            this.log(`${ICON[mode] || '📌'} ${label} ${f.name}: ${ok}/${pick.length}${stopped ? ' (熔断)' : ''}`, stopped ? 'err' : 'ok');
            if (stopped) break;
          }
          await this.b.call(SVC.visit, 'Leave', buildVisitLeave(f.gid)).catch(() => { });
          await sleep(200);
        } catch (e) {
          this.log(`${label} ${f.name} 失败: ${e.message}`, 'err');
        }
      }
      this.log(`✅ ${label} 完成: ${okTotal}/${landTotal}`, 'ok');
      await this.refresh();
    });
  }

  // 一键务农：帮好友清除地块上的草与虫（与撒虫撒草「放置」互补）
  // Farming 支持一次提交多块地，比 PutInsects/PutWeeds 逐块发高效得多。
  async taskFarming() {
    await this.guard('一键务农（帮好友清理草虫）', async () => {
      if (!this.friends.length) await this.refresh();
      // 先用好友摘要的 weed_num/insect_num 预筛，避免对没有草虫的好友做无谓 Enter。
      // 注意摘要可能滞后，因此仅作粗筛，真实判定仍以 Enter 回包 + 服务端 1001057 为准。
      const targets = this.friends.filter(f => f.gid !== this.gid && (f.weed > 0 || f.insect > 0));
      if (!targets.length) { this.log('务农：好友摘要显示均无草虫，跳过', 'task'); return; }
      this.log(`务农：${targets.length} 个好友有草虫记录`, 'task');
      let landTotal = 0, okTotal = 0, rewardTotal = 0;
      for (const f of targets) {
        try {
          // 服务端清理结果存在显示延迟：一轮过后可能仍有残留，做最多 3 轮收敛
          let cleared = 0;
          for (let round = 1; round <= 3; round++) {
            const er = await this.b.call(SVC.visit, 'Enter', buildVisitEnter(f.gid));
            const rep = parse(er.body);
            const cand = [];
            for (const bs of fields(rep, 2)) {
              const li = parse(bs);
              if (num(li, 2) === 0) continue;        // 未解锁
              if (num(li, 13) !== 0) continue;       // 副产地不可单独操作
              const pb = fields(li, 10)[0];
              if (!pb) continue;
              const p = parse(pb);
              const weedN = repeatedInts(p, 12).length;
              const insectN = repeatedInts(p, 13).length;
              if (weedN > 0 || insectN > 0) cand.push(num(li, 1));   // 有草或有虫才需要清理
            }
            if (!cand.length) {
              await this.b.call(SVC.visit, 'Leave', buildVisitLeave(f.gid)).catch(() => { });
              break;
            }
            if (round === 1) landTotal += cand.length;
            let r;
            try {
              r = await this.b.call(SVC.plant, 'Farming', buildFarming(cand, f.gid, true), 25000);
            } catch (e) {
              // 1001057 = 作物不需要务农（noop）。这是收敛信号，不是错误。
              if ((e.code || e.gateway?.meta?.err) === 1001057) {
                this.log(`务农 ${f.name} 第${round}轮: 服务端无更多可清理项，收敛`, 'task');
                break;
              }
              throw e;
            }
            const d = decodeFarmingReply(r.body);
            cleared += cand.length;
            okTotal += d.results.length;
            for (const x of d.results) if (x.reward) rewardTotal += x.reward.count || 0;
            this.log(`🧹 务农 ${f.name} 第${round}轮: 清理 ${d.results.length} 条 / 候选 ${cand.length} 块 → ${r.body ? r.body.length : 0}B`, 'ok');
            await sleep(300);
          }
          await this.b.call(SVC.visit, 'Leave', buildVisitLeave(f.gid)).catch(() => { });
          await sleep(150);
        } catch (e) {
          const code = e.code || e.gateway?.meta?.err || 0;
          this.log(`务农 ${f.name} 失败 [${code}] ${e.message}`, 'err');
          await this.b.call(SVC.visit, 'Leave', buildVisitLeave(f.gid)).catch(() => { });
        }
      }
      this.log(`✅ 务农完成: 清理 ${okTotal} 条${rewardTotal ? '，奖励合计 ' + rewardTotal : ''}`, 'ok');
      await this.refresh();
    });
  }

  // 挂机四件套：收获 → 种植 → 偷菜 → 务农
  // 撒虫/撒草属于「放置」类操作，有每日额度限制且会打扰好友，不进挂机循环，改用 / 指令手动触发。
  // ---- 指令（中文为主，保留英文别名）----
  async runCommand(raw) {
    const parts = String(raw).replace(/^\//, '').trim().split(/\s+/);
    const name = (parts[0] || '').toLowerCase();
    const arg = parts[1];
    const CMD = {
      // 日常四件套（挂机同款，无额度限制）
      '收获': 'harvest', 'harvest': 'harvest', 'h': 'harvest',
      '种植': 'plant', 'plant': 'plant', 'p': 'plant', '播种': 'plant',
      '偷菜': 'steal', 'steal': 'steal', 's': 'steal', '偷': 'steal',
      '务农': 'farming', 'farming': 'farming', 'd': 'farming', '除草除虫': 'farming',
      // 自家操作
      '铲除': 'clear', 'clear': 'clear', 'c': 'clear', '清理枯株': 'clear',
      // 放置类（有额度，手动触发）
      '撒虫': 'insect', 'insect': 'insect', 'i': 'insect', '放虫': 'insect',
      '撒草': 'weed', 'weed': 'weed', 'w': 'weed', '放草': 'weed',
      // 控制
      '全套': 'all', 'all': 'all', 'a': 'all',
      '挂机': 'monitor', 'monitor': 'monitor', 'm': 'monitor',
      '好友': 'where', 'where': 'where', '列表': 'where',
      '状态': 'status', 'status': 'status',
      'gid': 'setgid', '设置gid': 'setgid', '账号': 'setgid',
      '刷新': 'refresh', 'refresh': 'refresh', 'r': 'refresh',
      '退出': 'quit', 'quit': 'quit', 'exit': 'quit', 'q': 'quit',
      '帮助': 'help', 'help': 'help', '?': 'help', '': 'help',
    };
    const cmd = CMD[name];
    switch (cmd) {
      case 'help':
        this.log('━━ 指令一览（按 / 输入，Enter 执行）━━', 'task');
        this.log('【挂机四件套｜无额度限制，可反复执行】', 'ok');
        this.log('  /收获            收取成熟作物', 'task');
        this.log('  /种植 [种子ID]    自动补种空地（种子不足会自动购买）', 'task');
        this.log('  /偷菜 [gid]       偷取好友成熟果实（省略=全部好友）', 'task');
        this.log('  /务农            帮好友清除杂草与虫（有奖励，额度无限）', 'task');
        this.log('【自家操作】', 'ok');
        this.log('  /铲除            清理枯死植株（收获后残留）', 'task');
        this.log('【放置类｜每日 100 次共享额度，需指定好友 gid】', 'ok');
        this.log('  /撒虫 <gid>       给好友地块放虫', 'task');
        this.log('  /撒草 <gid>       给好友地块放草', 'task');
        this.log('【其他】', 'ok');
        this.log('  /好友            列出好友 gid 与草虫/可偷状态', 'task');
        this.log('  /全套            执行挂机四件套一次', 'task');
        this.log('  /挂机            开关自动挂机（每 60s 一轮四件套）', 'task');
        this.log('  /状态            查看桥接与账号状态', 'task');
        this.log('  /刷新            刷新数据并执行桥接自愈', 'task');
        this.log('  /退出            退出程序', 'task');
        break;
      case 'harvest': await this.taskHarvest(); break;
      case 'clear': await this.taskClear(); break;
      case 'plant': if (arg) this.seedId = Number(arg); await this.taskPlant(); break;
      case 'steal': await this.taskRaid('steal', arg); break;
      case 'insect': await this.taskRaid('insect', arg); break;
      case 'weed': await this.taskRaid('weed', arg); break;
      case 'farming': await this.taskFarming(); break;
      case 'all': await this.taskAll(); break;
      case 'monitor': this.toggleMonitor(); break;
      case 'refresh': await this.guard('刷新', async () => { await this.b.ensure({ onLog: m => this.log(m) }); await this.refresh(); this.log('已刷新', 'ok'); }); break;
      case 'where':
        await this.refresh();
        for (const f of this.friends) if (f.gid !== this.gid) this.log(`  ${f.name}  gid=${f.gid}  草${f.weed} 虫${f.insect} 偷${f.stealable}`, 'task');
        break;
      case 'status': {
        const p = await this.b.ping().catch(e => ({ ok: false, reason: e.message }));
        this.log('桥接: ' + JSON.stringify(p.ok ? p.status : p), 'task');
        if (!this.gid) {
          this.log('gid 尚未解析。可点 /好友 找到自己的 gid，然后用 /gid <数字> 设置', 'task');
        }
        break;
      }
      case 'setgid': {
        const n = Number(arg);
        if (n > 0 && Number.isFinite(n)) {
          this.gid = n;
          this.b.gid = n;
          this.log(`✅ 已设置 gid = ${n}`, 'ok');
          await this.refresh().catch(() => { });
        } else {
          this.log('用法: /gid <数字>（自己的 gid 可在 /好友 列表里找，注意排除好友）', 'err');
        }
        break;
      }
      case 'quit': this.quit = true; break;
      default: this.log(`未知指令 /${name}，输入 /帮助 查看全部`, 'err');
    }
  }

  async taskAll() {
    await this.taskHarvest();
    await this.taskPlant();
    await this.taskRaid('steal');
    await this.taskFarming();
  }

  toggleMonitor() {
    this.monitor = !this.monitor;
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    if (this.monitor) {
      this.log('[🤖] 挂机开启：每 60s 收获 → 种植 → 偷菜 → 务农', 'ok');
      const cycle = async () => {
        if (!this.monitor || this.busy) return;
        await this.taskHarvest();
        await this.taskPlant();
        await this.taskRaid('steal');
        await this.taskFarming();
      };
      this.monitorTimer = setInterval(cycle, 60000);
      cycle();
    } else {
      this.log('[⏸] 挂机关闭', 'task');
    }
  }

  // ---------- 主循环 ----------
  async run() {
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    this._started = true;   // 允许 log() 触发实时重绘
    const cleanup = () => {
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { }
    };
    process.on('exit', cleanup);

    // 中文指令需要正确的 UTF-8 解码，必须在 emitKeypressEvents 之前设置
    process.stdin.setEncoding('utf8');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('keypress', async (ch, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { this.quit = true; return; }

      // ---- / 指令输入模式 ----
      if (this.cmdMode) {
        if (key.name === 'escape') { this.cmdMode = false; this.cmdBuf = ''; return; }
        if (key.name === 'return' || key.name === 'enter') {
          const raw = this.cmdBuf.trim();
          this.cmdMode = false; this.cmdBuf = '';
          if (raw) { this.cmdHistory.push(raw); this.runCommand(raw); }
          return;
        }
        if (key.name === 'backspace') { this.cmdBuf = this.cmdBuf.slice(0, -1); return; }
        if (key.name === 'up') { const h = this.cmdHistory[this.cmdHistory.length - 1]; if (h) this.cmdBuf = h; return; }
        if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch >= ' ') { this.cmdBuf += ch; }
        return;
      }
      if (ch === '/') { this.cmdMode = true; this.cmdBuf = '/'; return; }

      switch (key.name) {
        case 'q': this.quit = true; break;
        case 'h': this.taskHarvest(); break;
        case 'p': this.taskPlant(); break;
        case 'c': this.taskClear(); break;
        case 'd': this.taskFarming(); break;
        case 'f': this.taskFriends(); break;
        case 's': this.taskRaid('steal'); break;
        case 'i': this.taskRaid('insect'); break;
        case 'w': this.taskRaid('weed'); break;
        case 'a': this.taskAll(); break;
        case 'm': this.toggleMonitor(); break;
        case 'r': this.guard('刷新', async () => { await this.b.ensure({ onLog: m => this.log(m) }); await this.refresh(); this.log('已刷新', 'ok'); }); break;
        case 'tab': this.focus = this.focus === 'farm' ? 'friends' : 'farm'; break;
      }
    });

    // 首屏
    try {
      await this.b.ensure({ onLog: (m) => this.log(m) });
      this.log(`[🔌] 桥接就绪 ctx=${this.b.ctxId}`, 'ok');
      if (!this.gid) this.gid = await this.b.detectGid({ onLog: (m) => this.log(m) });
      await this.refresh();
      this.log(`[✅] 加载完成：土地 ${this.lands.length} 好友 ${this.friends.length}`, 'ok');
      this.log('[🔑] 登录态已就绪，随时可挂机（[m] 或 /挂机）', 'ok');
      if (this.autoMonitor) { this.log('--monitor：自动开启挂机', 'ok'); this.toggleMonitor(); }
    } catch (e) {
      this.log('⚠️ 初始化未完成: ' + e.message, 'err');
      if (/gid/.test(e.message)) {
        this.log('👉 界面仍可使用。点 /好友 看列表，再用 /gid <你自己的gid> 手动设置', 'task');
        this.log('👉 收获/种植只依赖桥接，不依赖 gid，可直接按 [m] 挂机', 'task');
      } else {
        this.log('👉 按 [r] 重试；仍失败请检查游戏是否在运行、调试端口是否已开启', 'task');
      }
      this.log('👉 退出：按 [q] 或 Ctrl+C', 'task');
    }

    // 周期心跳
    const hb = setInterval(async () => {
      try {
        const p = await this.b.ping();
        this.conn = p.status;
        if (!p.ok) { this.b.status = 'error'; }
        else this.b.status = 'ready';
      } catch { this.b.status = 'error'; }
      this.render();
    }, 2000);

    // 周期数据刷新（低频）
    const rf = setInterval(async () => {
      if (!this.busy && this.b.status === 'ready') {
        try { await this.refresh(); } catch { }
      }
    }, 30000);

    while (!this.quit) { this.render(); await sleep(500); }
    clearInterval(hb); clearInterval(rf);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    cleanup();
    this.b.close();
    console.log(`${C.ok}已退出。${C.rst}`);
    process.exit(0);
  }
}

// ---------- 启动引导 ----------
function parseArgs() {
  const a = process.argv.slice(2);
  const o = { port: Number(process.env.CDP_PORT || 62000), gid: Number(process.env.MY_GID || 0) || null, seedId: 20002, yes: false, once: false, monitor: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port') o.port = Number(a[++i]);
    else if (a[i] === '--gid') o.gid = Number(a[++i]);
    else if (a[i] === '--seed') o.seedId = Number(a[++i]);
    else if (a[i] === '--once') o.once = true;
    else if (a[i] === '--monitor' || a[i] === '-m') o.monitor = true;
    else if (a[i] === '--yes' || a[i] === '-y') o.yes = true;
  }
  return o;
}

async function prompt(opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) => new Promise(res => rl.question(`${q}${def !== undefined ? ` ${C.dim}[${def}]${C.rst}` : ''}: `, a => res(a.trim() || def)));
  console.clear();
  console.log(`${C.brand}${C.b}QQ 农场挂机${C.rst}`);
  console.log(`${C.dim}运行时注入模式：不接触账号密码，复用游戏自身登录态${C.rst}\n`);
  console.log(`${C.dim}提示：需先开启调试端口（First / 微信调试），并保持游戏页面打开${C.rst}\n`);
  const port = await ask('调试端口 (CDP)', opts.port);
  const gid = await ask('自己的 gid（回车自动探测）', opts.gid || '');
  const seed = await ask('种植种子 ID', opts.seedId);
  rl.close();
  return { port: Number(port), gid: gid ? Number(gid) : null, seedId: Number(seed), yes: opts.yes };
}

const IS_MAIN = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/tui.mjs');
if (IS_MAIN) {
  const opts = parseArgs();

  // ---- 无界面模式：跑一轮全套任务后退出（适合做定时任务）----
  if (opts.once) {
    const b = new Bridge({ port: opts.port, gid: opts.gid });
    const t = new Tui(b, { ...opts, headless: true });
    let code = 0;
    try {
      console.log(`${C.brand}QQ 农场挂机 · 单次执行${C.rst}  CDP ${opts.port}`);
      await b.ensure({ onLog: (m) => t.log(m) });
      t.log(`[🔌] 桥接就绪 ctx=${b.ctxId}`, 'ok');
      if (!t.gid) t.gid = await b.detectGid({ onLog: (m) => t.log(m) });
      await t.refresh();
      t.log(`账号 ${t.acct?.name || '?'} (lv${t.acct?.level ?? '?'}) gid=${t.gid} 土地=${t.lands.length} 好友=${t.friends.length}`, 'ok');

      // 与挂机循环保持一致：收获 → 种植 → 偷菜 → 务农
      // （撒虫/撒草属放置类操作，有额度限制，需用 /insect /weed 手动触发）
      await t.taskAll();

      const unlocked = t.lands.filter(l => l.unlocked);
      const mains = unlocked.filter(l => l.masterLandId === 0);
      t.log(`收尾：主地 ${mains.length} 成熟 ${mains.filter(l => l.plant?.isRipe).length} 空地 ${mains.filter(l => !l.plant?.id).length} 枯死 ${mains.filter(l => l.plant?.currentPhase === 7).length}`, 'ok');
    } catch (e) {
      t.log('执行失败: ' + e.message, 'err');
      code = 1;
    } finally {
      b.close();
      setTimeout(() => process.exit(code), 150);
    }
  } else {
    const finalOpts = opts.yes ? opts : await prompt(opts);
    const b = new Bridge({ port: finalOpts.port, gid: finalOpts.gid });
    const tui = new Tui(b, finalOpts);
    await tui.run();
  }
}
export { Tui };
