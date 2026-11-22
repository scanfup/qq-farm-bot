(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const preferenceDefaults = { seedPriority: [], animalPriority: [], seedFallback: false, animalFallback: false, allowAnimalPurchase: false, maxAnimalSpendPerCycle: 0 };
  const monitorDefaults = { farm: { intervalSec: 300, friendsEnabled: true }, pasture: { intervalSec: 300, friendsEnabled: true, feedEnabled: true } };
  const state = { value: null, source: null, busy: false, lastMode: null, monitorUpdating: { farm: false, pasture: false }, monitorDirty: { farm: false, pasture: false }, preferenceDirty: { seed: false, animal: false }, preferenceSaving: {}, seedCatalog: new Map(), animalCatalog: new Map(), selectSignatures: {} };
  state.preferenceDraft = { ...preferenceDefaults, seedPriority: [], animalPriority: [] }; state.monitorDraft = { farm: { ...monitorDefaults.farm }, pasture: { ...monitorDefaults.pasture } };
  const labels = { 'farm-manage': '农场一键务农', 'pasture-manage': '牧场一键务农', harvest: '收获', plant: '种植', 'plant-priority': '按优先级种植', care: '务农（自家+好友）', 'remove-dead': '清理枯株', connect: '连接', refresh: '刷新', 'friends-refresh': '刷新好友', 'friend-visit': '查看好友', 'friend-steal': '好友偷菜', 'friend-care': '帮好友务农', 'friend-insect': '给好友撒虫', 'friend-weed': '给好友撒草', 'pasture-refresh': '刷新牧场', 'pasture-visit': '查看好友牧场', 'pasture-produce': '牧场接生 / 开始生产', 'pasture-harvest': '牧场收取', 'pasture-clean': '牧场清理', 'pasture-place': '按优先级补栏', 'pasture-feed': '库存补牧草', 'pasture-buy': '购买动物', 'pasture-friends-clean': '清理好友牧场', 'pasture-friends-steal': '摘取好友产物' };
  const statusLabels = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', uncertain: '待核对' };
  const friendTypes = new Set(['friends-refresh', 'friend-visit', 'friend-steal', 'friend-care', 'friend-insect', 'friend-weed']);
  const pastureTypes = new Set(['pasture-manage', 'pasture-refresh', 'pasture-visit', 'pasture-produce', 'pasture-harvest', 'pasture-clean', 'pasture-place', 'pasture-feed', 'pasture-buy', 'pasture-friends-clean', 'pasture-friends-steal']);
  const pastureReads = new Set(['pasture-refresh', 'pasture-visit']);
  const esc = v => String(v ?? '');
  const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const gidKey = value => /^\d+$/.test(String(value ?? '')) && !/^0+$/.test(String(value)) ? String(value).replace(/^0+(?=\d)/, '') : '';
  const fmtTime = v => { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  const fmtCountdown = v => { if (!v) return ''; const n = Number(v) * 1000 - Date.now(); if (!Number.isFinite(n) || n <= 0) return '已成熟'; const sec = Math.floor(n / 1000); return sec >= 3600 ? `${Math.floor(sec / 3600)}小时${Math.floor(sec % 3600 / 60)}分` : `${Math.floor(sec / 60)}分${sec % 60}秒`; };
  const husbandryName = value => Number(value) === 1 ? '窝' : Number(value) === 2 ? '棚' : '类型待确认';
  const fmtCrop = p => p?.name || '空地';
  const iconFor = p => !p?.id ? '◌' : p.isRipe ? '✿' : p.needCare ? '♧' : '🌱';
  const connected = () => !state.friendDisconnected && ['ready', 'demo'].includes(state.value?.connection?.status);
  const ownedSeeds = () => Array.isArray(state.value?.seeds) ? state.value.seeds.filter(x => validId(x.seed) && Number(x.count) > 0) : [];
  const selectedSeed = () => state.value?.inventory?.status === 'ready' ? ownedSeeds().find(x => String(Number(x.seed)) === $('#seedSelect').value && x.canPlant === true) : null;
  const isSelfFriend = (friend, fs) => friend.isSelf === true || (!!gidKey(fs?.selfGid) && gidKey(friend.gid) === gidKey(fs.selfGid));
  const friendReady = fs => fs?.status === 'ready' && connected();
  const friendWritable = fs => friendReady(fs) && !!fs.identitySource && !state.value?.needsReconcile;
  const friendPending = () => state.friendBusy || (state.value?.jobs || []).some(j => (friendTypes.has(j.type) || ['care','farm-manage'].includes(j.type)) && ['queued', 'running'].includes(j.status));
  const pastureReady = ps => ps?.status === 'ready' && connected();
  const pastureWritable = ps => pastureReady(ps) && validId(ps.selfGid) && !state.value?.needsReconcile;
  const pasturePending = () => state.pastureBusy || (state.value?.jobs || []).some(j => pastureTypes.has(j.type) && ['queued', 'running'].includes(j.status));
  const pastureFriends = ps => Array.isArray(ps?.friends?.items) ? ps.friends.items : [];
  const pastureTargets = ps => pastureFriends(ps).filter(f => validId(f.gid) && !isSelfFriend(f, ps));
  const inventoryReady = ps => (typeof ps?.inventoryStatus === 'string' ? ps.inventoryStatus : ps?.inventoryStatus?.status) === 'ready';
  function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = String(text); return el; }
  function showNotice(message, error = false, ttl = 6000) { const n = $('#notice'); n.textContent = message; n.classList.remove('hidden'); n.style.background = error ? '#fff0ee' : '#fff3d8'; n.style.color = error ? '#a04e46' : '#916321'; clearTimeout(showNotice.t); showNotice.t = setTimeout(() => n.classList.add('hidden'), ttl); }
  function syncSettings(s) {
    const saved = { ...preferenceDefaults, ...(s.preferences || {}) };
    if (!state.preferenceDraft) state.preferenceDraft = { ...saved, seedPriority: [...saved.seedPriority], animalPriority: [...saved.animalPriority] };
    if (!state.preferenceDirty.seed && !state.preferenceSaving.seed) { state.preferenceDraft.seedPriority = [...(saved.seedPriority || [])]; state.preferenceDraft.seedFallback = !!saved.seedFallback; }
    if (!state.preferenceDirty.animal && !state.preferenceSaving.animal) for (const key of ['animalPriority', 'animalFallback', 'allowAnimalPurchase', 'maxAnimalSpendPerCycle']) state.preferenceDraft[key] = key === 'animalPriority' ? [...(saved[key] || [])] : saved[key];
    for (const scope of ['farm','pasture']) if (!state.monitorDirty[scope] && !state.monitorUpdating[scope]) state.monitorDraft[scope] = { ...monitorDefaults[scope], ...(s.monitors?.[scope] || {}) };
    for (const seed of [...(s.seedOptions || []), ...(s.seeds || [])]) if (validId(seed.seed)) state.seedCatalog.set(Number(seed.seed), seed.name || `种子 ${seed.seed}`);
    for (const animal of s.pastureState?.animals || []) if (validId(animal.animalId)) state.animalCatalog.set(Number(animal.animalId), { name: animal.name || `动物 ${animal.animalId}`, husbandryType: animal.husbandryType });
  }
  function seedOptions() {
    const byId = new Map();
    for (const seed of [...(state.value?.seedOptions || []), ...(state.value?.seeds || [])]) if (validId(seed.seed)) byId.set(Number(seed.seed), { ...seed, seed: Number(seed.seed), count: Number(seed.count) || 0 });
    for (const id of [...(state.preferenceDraft?.seedPriority || []), ...(state.value?.preferences?.seedPriority || []), state.manualSeed]) if (validId(id) && !byId.has(Number(id))) byId.set(Number(id), { seed: Number(id), name: state.seedCatalog.get(Number(id)) || `种子 ${id}`, count: 0, canPlant: false });
    return [...byId.values()];
  }
  function animalOptions() {
    const byId = new Map((state.value?.pastureState?.animals || []).filter(a => validId(a.animalId)).map(a => [Number(a.animalId), { ...a, animalId: Number(a.animalId), count: Number(a.count) || 0 }]));
    for (const id of [...(state.preferenceDraft?.animalPriority || []), ...(state.value?.preferences?.animalPriority || [])]) if (validId(id) && !byId.has(Number(id))) byId.set(Number(id), { animalId: Number(id), ...(state.animalCatalog.get(Number(id)) || { name: `动物 ${id}` }), count: 0, unlocked: false });
    return [...byId.values()];
  }
  function syncSelect(el, choices, placeholder, preferred = '') {
    const old = el.value || String(preferred || '');
    const signature = JSON.stringify([placeholder, choices]);
    if (state.selectSignatures[el.id] !== signature) {
      el.textContent = ''; const empty = node('option', '', placeholder); empty.value = ''; el.appendChild(empty);
      for (const choice of choices) { const option = node('option', '', choice.text); option.value = String(choice.value); option.disabled = !!choice.disabled; el.appendChild(option); }
      state.selectSignatures[el.id] = signature;
    }
    el.value = choices.some(choice => String(choice.value) === old) ? old : '';
  }
  function render(s) {
    if (!s) return; state.value = s; syncSettings(s);
    const mode = s.mode || 'live'; const badge = $('#modeBadge'); badge.textContent = mode === 'demo' ? 'Demo 演示数据' : 'Live 实时模式'; badge.className = `mode-badge ${mode}`;
    if (state.lastMode !== mode) { state.lastMode = mode; if (mode === 'demo') showNotice('当前为 Demo 模式，页面数据不是真实账号。'); }
    const c = s.connection || {}; const names = { ready: '已连接', idle: '空闲', connecting: '连接中', error: '连接错误', demo: '演示模式' }; $('#connectionState').textContent = mode === 'demo' ? '演示模式' : (names[c.status] || c.status || '未连接'); $('#connectionDot').classList.toggle('ok', c.status === 'ready'); $('#portValue').textContent = c.port || '—'; $('#contextValue').textContent = c.contextId || '—'; $('#lastError').textContent = c.lastError || '';
    const snap = s.snapshot, lands = Array.isArray(snap?.lands) ? snap.lands : [], main = lands.filter(l => l.unlocked && l.masterLandId === 0 && l.plant?.currentPhase !== 7);
    $('#landCount').textContent = snap ? lands.filter(l => l.unlocked).length : '—'; $('#ripeCount').textContent = main.filter(l => l.plant?.isRipe).length; $('#careCount').textContent = main.filter(l => l.plant?.needCare).length; $('#fetchedAt').textContent = snap ? `最近同步 ${fmtTime(snap.fetchedAt)}` : 'Live 未连接，暂无地块快照';
    renderSeeds(s.seeds || [], s.monitor || {}, s.inventory); renderPreferences(); renderPasture(s.pastureState); renderFriends(s.friendState); renderLands(lands); renderActivity(s.jobs || [], s.logs || []);
    $('#runtimeSummary').textContent = mode === 'demo' ? '演示模式' : (names[c.status] || '未连接');
    $('#landSummary').textContent = `${lands.filter(l => l.unlocked).length} 块已解锁 · ${main.filter(l => l.plant?.isRipe).length} 块待收获`;
    renderWriteGuards();
  }
  function renderSeeds(seeds, monitor, inventory) {
    const el = $('#seedSelect'), status = inventory?.status || 'not-loaded';
    const owned = ownedSeeds(), available = owned.filter(s => s.canPlant === true);
    const chosen = state.manualSeed || el.value || '';
    const all = seedOptions();
    const choices = all.filter(s => Number(s.count) > 0 || String(s.seed) === String(chosen)).map(s => ({ value: s.seed, text: `${s.name || s.seed} ×${s.count}（${s.seed}）${s.count <= 0 ? ' · 库存不足，保留选择' : ''}`, disabled: status !== 'ready' || s.count <= 0 || s.canPlant !== true }));
    syncSelect(el, choices, status === 'ready' ? '选择背包种子' : '等待加载种子库存', chosen);
    if (chosen) el.value = String(chosen);
    el.disabled = status !== 'ready' || !available.length;
    document.querySelectorAll('[data-command="plant"]').forEach(button => { button.disabled = !selectedSeed() || state.busy || !!state.value?.needsReconcile; button.title = state.value?.needsReconcile ? '请先刷新核对上次操作结果' : selectedSeed() ? '使用明确选择的背包种子' : '选择的种子无库存或不可种植；不会自动换种'; });
    let message = status === 'ready' ? `背包种子：${owned.length} 种，共 ${owned.reduce((n, s) => n + Number(s.count), 0)} 颗` : status === 'error' ? `种子库存读取失败：${inventory?.error || '请刷新重试'}` : '种子库存尚未加载，请连接运行时后刷新状态';
    if (chosen && !selectedSeed()) message += ' · 原选择已保留，当前不可种植；未自动切换其它种子';
    if (inventory?.warning) message += `；提示：${inventory.warning}`;
    if (status === 'ready' && inventory?.fetchedAt) message += ` · 同步 ${fmtTime(inventory.fetchedAt)}`;
    $('#seedInventoryStatus').textContent = message;
  }
  const hasPriorityPolicy = group => !!(state.value?.preferences?.[group + 'Priority'] || []).length || state.value?.preferences?.[group + 'Fallback'] === true;
  function markPreferenceDirty(group) { state.preferenceDirty[group] = true; renderPreferences(); renderWriteGuards(); }
  function renderPreferences() {
    const draft = state.preferenceDraft || preferenceDefaults;
    for (const [group, options, key] of [['seed', seedOptions(), 'seed'], ['animal', animalOptions(), 'animalId']]) {
      const ids = draft[group + 'Priority'] || [], select = $('#' + group + 'PrioritySelect');
      syncSelect(select, options.map(item => ({ value: item[key], text: `${item.name || item[key]} ×${item.count}${group === 'animal' ? ` · ${husbandryName(item.husbandryType)}` : ''}${ids.map(Number).includes(Number(item[key])) ? ' · 已加入' : ''}` })), `选择${group === 'seed' ? '种子' : '动物'}加入优先列表`);
      $('#' + group + 'PriorityAdd').disabled = !validId(select.value) || ids.length >= 20 || ids.map(Number).includes(Number(select.value));
      const list = $('#' + group + 'PriorityList'); list.textContent = '';
      if (!ids.length) list.appendChild(node('li', 'muted-empty', draft[group + 'Fallback'] ? '未指定优先项；已允许使用其它有库存项，保存后生效。' : '尚未设置优先项，请添加后保存。'));
      ids.forEach((id, index) => {
        const item = options.find(value => Number(value[key]) === Number(id));
        const row = node('li', 'priority-item'); const info = node('div', 'priority-info'); info.append(node('strong', '', `${index + 1}. ${item?.name || `${group === 'seed' ? '种子' : '动物'} ${id}`}`), node('small', Number(item?.count) > 0 ? 'friend-muted' : 'priority-zero', `ID ${id} · 库存 ${Number(item?.count) || 0}${Number(item?.count) > 0 ? '' : ' · 保留优先项'}`));
        const controls = node('div', 'priority-controls');
        for (const [action, label] of [['up', '↑'], ['down', '↓'], ['remove', '移除']]) { const button = node('button', 'btn btn-small btn-ghost', label); button.disabled = action === 'up' ? index === 0 : action === 'down' ? index === ids.length - 1 : false; button.setAttribute('aria-label', `${action === 'up' ? '上移' : action === 'down' ? '下移' : '移除'} ${item?.name || id}`); button.addEventListener('click', () => changePriority(group, index, action)); controls.appendChild(button); }
        row.append(info, controls); list.appendChild(row);
      });
      $('#' + group + 'Fallback').checked = !!draft[group + 'Fallback'];
      const save = $('#save' + (group === 'seed' ? 'Seed' : 'Animal') + 'Preferences'); save.disabled = !!state.preferenceSaving[group]; save.textContent = state.preferenceSaving[group] ? '保存中…' : `保存${group === 'seed' ? '种子' : '动物'}优先设置${state.preferenceDirty[group] ? ' *' : ''}`;
    }
    $('#allowAnimalPurchase').checked = !!draft.allowAnimalPurchase;
    if (!state.preferenceDirty.animal && document.activeElement !== $('#maxAnimalSpendPerCycle')) $('#maxAnimalSpendPerCycle').value = draft.maxAnimalSpendPerCycle ?? 0;
    $('#preferencesStatus').textContent = Object.values(state.preferenceDirty).some(Boolean) ? '有未保存的优先设置，定时任务仍使用已保存值' : '优先设置已同步';
    $('#preferencesStatus').classList.toggle('settings-dirty', Object.values(state.preferenceDirty).some(Boolean));
  }
  function addPriority(group) { const id = Number($('#' + group + 'PrioritySelect').value), key = group + 'Priority'; if (!validId(id) || state.preferenceDraft[key].map(Number).includes(id)) return; if (state.preferenceDraft[key].length >= 20) { showNotice('每组优先设置最多可添加 20 项。', true); return; } state.preferenceDraft[key].push(id); markPreferenceDirty(group); }
  function changePriority(group, index, action) { const ids = state.preferenceDraft[group + 'Priority']; if (action === 'remove') ids.splice(index, 1); else { const next = index + (action === 'up' ? -1 : 1); if (next < 0 || next >= ids.length) return; [ids[index], ids[next]] = [ids[next], ids[index]]; } markPreferenceDirty(group); }
  async function savePreferences(group) {
    if (state.preferenceSaving[group]) return;
    const draft = state.preferenceDraft, payload = group === 'seed' ? { seedPriority: [...draft.seedPriority], seedFallback: !!draft.seedFallback } : { animalPriority: [...draft.animalPriority], animalFallback: !!draft.animalFallback, allowAnimalPurchase: !!draft.allowAnimalPurchase, maxAnimalSpendPerCycle: Number($('#maxAnimalSpendPerCycle').value) };
    if (group === 'animal' && ($('#maxAnimalSpendPerCycle').value.trim() === '' || !Number.isSafeInteger(payload.maxAnimalSpendPerCycle) || payload.maxAnimalSpendPerCycle < 0 || payload.maxAnimalSpendPerCycle > 1000000)) { showNotice('单周期购买预算必须为 0–1000000 的整数。', true); return; }
    if (group === 'animal' && payload.allowAnimalPurchase && payload.maxAnimalSpendPerCycle === 0) { showNotice('允许自动购买时，请设置大于 0 的单周期预算。', true); return; }
    state.preferenceSaving[group] = true; renderPreferences();
    try { await post('/api/preferences', payload, false); state.preferenceDirty[group] = false; state.preferenceSaving[group] = false; await load(); showNotice(`${group === 'seed' ? '种子' : '动物'}优先设置已保存，定时任务将使用此顺序。`); }
    catch (_) {} finally { state.preferenceSaving[group] = false; renderPreferences(); renderWriteGuards(); }
  }
  function monitorBlockReason(scope) {
    const draft = state.monitorDraft[scope];
    if (state.value?.needsReconcile) return '请先刷新核对上次操作结果。';
    if (!connected()) return '请先连接游戏运行时。';
    const group = scope === 'farm' ? 'seed' : 'animal';
    if (state.preferenceDirty[group]) return '优先设置尚未保存，请先保存。';
    if (scope === 'farm') {
      if (state.value?.inventory?.status !== 'ready') return '请先成功读取农场种子库存。';
      if (!hasPriorityPolicy('seed') && !selectedSeed()) return '请保存种子优先级，或明确选择一个有库存的背包种子。';
      if (draft.friendsEnabled && !friendWritable(state.value?.friendState)) return '请先刷新好友并确认账号身份，或取消包含好友。';
    } else {
      const ps = state.value?.pastureState;
      if (!pastureWritable(ps) || !inventoryReady(ps)) return '请先成功刷新牧场及动物库存。';
      if (draft.friendsEnabled && ps?.friends?.status !== 'ready') return '请先刷新牧场好友，或取消包含好友。';
    }
    return '';
  }
  function renderMonitorPanels() {
    const monitors = state.value?.monitors || {};
    const on = ['farm','pasture'].filter(scope => monitors[scope]?.enabled);
    $('#monitorSummary').textContent = on.length ? on.map(scope => (scope === 'farm' ? '农场' : '牧场') + '托管中').join(' · ') : '托管均关闭';
    $('#monitorSummary').classList.toggle('monitor-running', !!on.length);
    for (const scope of ['farm','pasture']) {
      const saved = monitors[scope] || {}, draft = state.monitorDraft[scope], busy = state.monitorUpdating[scope];
      const toggle = $('#' + scope + 'MonitorToggle'), interval = $('#' + scope + 'MonitorInterval');
      const reason = monitorBlockReason(scope);
      if (!busy) toggle.checked = !!saved.enabled;
      toggle.disabled = busy;
      toggle.setAttribute('aria-describedby', scope + 'MonitorHint');
      toggle.title = saved.enabled ? '停止本场景托管，不影响另一个场景' : reason || '启用本场景独立托管';
      if (!busy && document.activeElement !== interval) interval.value = draft.intervalSec;
      $('#' + scope + 'MonitorFriends').checked = !!draft.friendsEnabled;
      if (scope === 'pasture') $('#pastureMonitorFeed').checked = !!draft.feedEnabled;
      $('#' + scope + 'MonitorApply').disabled = busy;
      $('#' + scope + 'MonitorStatus').textContent = saved.enabled ? (saved.running ? '本轮执行中' : saved.waiting ? '本轮等待空闲' : '托管已开启') + ' · 每 ' + saved.intervalSec + ' 秒' + (saved.nextRunAt ? ' · 下次 ' + fmtTime(saved.nextRunAt) : '') : '已关闭' + (saved.lastRunAt ? ' · 上次 ' + fmtTime(saved.lastRunAt) : '');
      const description = scope === 'farm' ? '自动收获、清枯株、按已保存优先级或明确选择的种子补种，再照料及好友偷菜。' : '牧场托管无需选择种子；自动清理、库存补草、生产、收取、优先补栏及好友操作。';
      $('#' + scope + 'MonitorHint').textContent = description + '关闭网页仍运行；服务/电脑关闭后停止，重启不自动开启。' + (state.monitorDirty[scope] ? ' 设置尚未应用。' : '') + (saved.lastError ? ' 上轮异常：' + saved.lastError : '') + (!saved.enabled && reason ? ' · ' + reason : '');
    }
  }
  function renderWriteGuards() {
    const locked = !!state.value?.needsReconcile;
    document.querySelectorAll('[data-command]').forEach(button => {
      const type = button.dataset.command;
      if (type !== 'plant') button.disabled = locked || state.busy || (['care','farm-manage'].includes(type) && !friendWritable(state.value?.friendState)) || (type === 'farm-manage' && friendPending()) || (type === 'plant-priority' && (state.preferenceDirty.seed || !hasPriorityPolicy('seed')));
      if (locked) button.title = '请先刷新核对上次操作结果'; else if (['care','farm-manage'].includes(type)) button.title = friendWritable(state.value?.friendState) ? (type === 'farm-manage' ? '照料自家，再对全部好友帮忙务农和偷菜；不进入牧场' : '照料自家及好友') : '请先刷新好友并确认账号身份'; else if (type === 'plant-priority') button.title = '按已保存顺序选择种子；不擅自更换无库存优先项'; else button.title = '';
    });
    renderMonitorPanels();
    document.querySelectorAll('[data-pasture-command]').forEach(button => { const type = button.dataset.pastureCommand, ps = state.value?.pastureState; button.disabled = pasturePending() || !pastureWritable(ps) || ((['pasture-place','pasture-feed','pasture-manage'].includes(type)) && !inventoryReady(ps)) || (type === 'pasture-place' && (state.preferenceDirty.animal || !hasPriorityPolicy('animal'))) || (type === 'pasture-manage' && (state.preferenceDirty.animal || ps?.friends?.status !== 'ready')) || (type.startsWith('pasture-friends-') && (ps?.friends?.status !== 'ready' || !pastureTargets(ps).length)); button.title = locked ? '请先刷新核对上次操作结果' : type === 'pasture-manage' ? '仅管理牧场：自家清理、库存补草、生产、收取、优先补栏及全部好友清理摘取；请先保存动物偏好' : type === 'pasture-place' ? '只使用已保存动物优先设置，按真实容量补栏' : ''; });
    renderBuy();
  }
  function renderFriends(fs) {
    fs = fs || { status: 'not-loaded' }; const ready = friendReady(fs), busy = !!friendPending(), friends = Array.isArray(fs.friends) ? fs.friends : [], others = friends.filter(f => !isSelfFriend(f, fs)), targets = others.filter(f => f.hasSummary === true), writable = friendWritable(fs);
    $('#friendCount').textContent = fs.status === 'ready' ? `${others.length} 位好友` : '—';
    let message = fs.status === 'ready' ? `已加载 ${friends.length} 条记录 · 同步 ${fmtTime(fs.fetchedAt)}` : fs.status === 'error' ? `好友读取失败：${fs.error || '请重试'}` : '好友数据尚未加载，请主动刷新好友列表；这不代表没有好友。';
    if (state.friendDisconnected) message += ' · 实时连接已中断，好友写操作已暂停'; else if (!['ready', 'demo'].includes(state.value?.connection?.status)) message += ' · 请先连接游戏运行时';
    if (state.value?.needsReconcile) message += ' · 上次操作结果待核对，请先刷新；查看与刷新好友仍可用';
    if (fs.status === 'ready' && !fs.identitySource) message += ' · 当前账号身份未确认，好友写操作已暂停';
    $('#friendStatus').textContent = message; $('#friendStatus').classList.toggle('friend-error', fs.status === 'error' || !!state.friendDisconnected);
    const account = typeof fs.account === 'string' ? fs.account : fs.account?.name || fs.account?.nickname || '';
    $('#friendAccount').textContent = gidKey(fs.selfGid) ? `当前账号${account ? '：' + account : ''} · 自己的 GID ${fs.selfGid}` : '当前账号身份尚未确认；后端会校验好友操作对象';
    $('#friendsRefreshBtn').disabled = busy; const stealable = f => f.hasSummary === true && Number(f.stealable) > 0;
    $('#friendStealAllBtn').disabled = !writable || busy || !targets.some(stealable); $('#friendCareAllBtn').disabled = !writable || busy || !targets.length;
    const quota = fs.quota, knownQuota = quota && Number.isFinite(Number(quota.remaining));
    $('#friendQuota').textContent = knownQuota ? `撒虫 / 撒草共享每日额度（10003）：剩余 ${quota.remaining} 次 · 已用 ${quota.dayTimes} / ${quota.dayLimit}` : '撒虫 / 撒草共享每日额度（10003）：尚未加载，暂不可操作'; $('#friendQuota').classList.toggle('friend-error', !!knownQuota && Number(quota.remaining) <= 0);
    const list = $('#friendList'); list.textContent = '';
    if (fs.status !== 'ready') list.appendChild(node('div', 'muted-empty', fs.status === 'error' ? '读取失败，旧好友数据不可操作。请刷新好友列表。' : '尚未读取好友列表，不代表没有好友。'));
    else {
      const query = $('#friendSearch').value.trim().toLocaleLowerCase(), visible = friends.filter(f => !query || String(f.name || '').toLocaleLowerCase().includes(query) || String(f.gid).includes(query));
      if (!visible.length) list.appendChild(node('div', 'muted-empty', friends.length ? '没有匹配的昵称或 GID。' : '本次全量查询没有返回好友记录。'));
      for (const f of visible) {
        const self = isSelfFriend(f, fs), row = node('article', `friend-row${self ? ' friend-self' : ''}`), info = node('div', 'friend-info'), heading = node('div', 'friend-name'); heading.appendChild(node('strong', '', f.name || '未命名好友')); if (self) heading.appendChild(node('span', 'self-badge', '自己'));
        info.append(heading, node('div', 'friend-muted', `Lv.${f.level ?? '—'} · GID ${f.gid ?? '—'}`), node('div', 'friend-summary', f.hasSummary === true ? `可偷 ${f.stealable ?? 0} · 杂草 ${f.weed ?? 0} · 害虫 ${f.insect ?? 0}` : '无农场摘要，暂不可操作')); row.appendChild(info); const actions = node('div', 'friend-row-actions');
        if (!self) for (const [type, label] of [['friend-visit', '查看'], ['friend-steal', '偷菜'], ['friend-care', '帮忙务农'], ['friend-insect', '撒虫'], ['friend-weed', '撒草']]) {
          const button = node('button', `btn btn-small ${['friend-insect', 'friend-weed'].includes(type) ? 'btn-caution' : 'btn-ghost'}`, label), placement = ['friend-insect', 'friend-weed'].includes(type);
          button.disabled = !ready || busy || !gidKey(f.gid) || f.hasSummary !== true || (type !== 'friend-visit' && !writable) || (type === 'friend-steal' && !stealable(f)) || (placement && (!knownQuota || Number(quota.remaining) <= 0)); button.title = placement ? '与撒虫 / 撒草共用每日额度，仅手动执行' : type === 'friend-care' ? '后端检查实际地块，不按摘要预筛' : label;
          button.addEventListener('click', () => { void friendCommand(type, f.gid); }); actions.appendChild(button);
        } else actions.appendChild(node('span', 'friend-muted', '自家操作请使用上方农务区'));
        row.appendChild(actions); list.appendChild(row);
      }
    }
    renderFriendPreview(fs);
  }
  function renderFriendPreview(fs) {
    const preview = fs.preview, key = preview ? `${preview.gid}:${preview.fetchedAt}` : '', panel = $('#friendPreview'), show = !!preview && key !== state.closedFriendPreview; panel.classList.toggle('hidden', !show); if (!show) return;
    state.currentFriendPreview = key; $('#friendPreviewTitle').textContent = `好友农场预览 · ${preview.name || '未命名好友'}（GID ${preview.gid}）`; $('#friendPreviewStatus').textContent = `缓存时间 ${fmtTime(preview.fetchedAt)}${fs.status !== 'ready' ? ' · 好友状态不可用，此预览仅为历史缓存' : ''}`;
    const el = $('#friendPreviewLands'); el.textContent = ''; const records = Array.isArray(preview.lands) ? preview.lands : []; if (!records.length) el.appendChild(node('div', 'muted-empty', '本次预览没有地块记录。'));
    for (const land of records) { const p = land.plant, dead = p?.currentPhase === 7, card = node('article', 'friend-land'); card.append(node('strong', '', `地块 ${land.id} · ${land.unlocked ? 'Lv.' + (land.level || 1) : '未解锁'}`), node('span', '', !land.unlocked ? '暂未开放' : !p?.id ? '空地' : `${p.name || '作物'} · ${dead ? '枯株' : p.isRipe ? '已成熟' : '生长中'}`)); if (p?.id && !dead && !p.isRipe && p.ripeAt) card.appendChild(node('small', 'friend-muted', `成熟倒计时 ${fmtCountdown(p.ripeAt)}`)); if (p?.needCare) card.appendChild(node('small', 'friend-muted', '需要照料')); el.appendChild(card); }
  }
  async function friendCommand(type, gid) {
    try {
      if (!friendTypes.has(type) || friendPending()) return; const fs = state.value?.friendState;
      if (type !== 'friends-refresh') {
        if (!friendReady(fs)) { showNotice('请先连接运行时并成功刷新好友列表。', true); return; }
        if (type !== 'friend-visit' && !friendWritable(fs)) { showNotice(state.value?.needsReconcile ? '请先刷新核对上次操作结果。' : '当前账号身份尚未确认，请刷新好友。', true); return; }
        if (gid != null) { const f = fs.friends?.find(item => gidKey(item.gid) === gidKey(gid)); if (!gidKey(gid) || !f || isSelfFriend(f, fs) || f.hasSummary !== true) { showNotice('请选择有农场摘要的其他好友。', true); return; } if (type === 'friend-steal' && Number(f.stealable) <= 0) { showNotice('该好友当前摘要可偷数量为 0，请先刷新。', true); return; } }
        else if (!['friend-steal', 'friend-care'].includes(type)) { showNotice('此操作必须指定好友。', true); return; }
        if (['friend-insect', 'friend-weed'].includes(type) && (!fs.quota || !Number.isFinite(Number(fs.quota.remaining)) || Number(fs.quota.remaining) <= 0)) { showNotice('撒虫 / 撒草额度未加载或已耗尽。', true); return; }
      }
      const payload = { commandId: crypto.randomUUID(), type }; if (gid != null) payload.gid = Number.isSafeInteger(Number(gid)) ? Number(gid) : String(gid); if (type === 'friend-visit') state.closedFriendPreview = null;
      state.friendBusy = true; renderFriends(fs); await post('/api/commands', payload);
    } catch (e) { showNotice(`好友操作失败：${e.message}`, true); } finally { state.friendBusy = false; renderFriends(state.value?.friendState); renderWriteGuards(); }
  }
  function renderRanches(el, ranches) {
    el.textContent = ''; if (!ranches.length) { el.appendChild(node('div', 'muted-empty', '本次没有栏舍记录。')); return; }
    for (const ranch of ranches) {
      const id = ranch.ranch_inst_id ?? ranch.ranchInstId, type = Number(ranch.husbandry_type ?? ranch.husbandryType), animals = Array.isArray(ranch.animals) ? ranch.animals : [], hazards = Array.isArray(ranch.hazards) ? ranch.hazards : [], shelves = Array.isArray(ranch.shelves) ? ranch.shelves : [];
      const card = node('article', 'ranch-card'), heading = node('div', 'ranch-heading'); heading.append(node('strong', '', `${husbandryName(type)} #${id ?? '—'}`), node('span', 'ranch-capacity', `${ranch.animal_count ?? ranch.animalCount ?? animals.length} / ${ranch.capacity ?? '—'}`));
      card.append(heading, node('div', 'ranch-meta', `牧草 ${ranch.grass?.amount ?? ranch.grassAmount ?? '—'} · 危害 ${hazards.length} · 可收货架 ${shelves.filter(s => s.can_collect ?? s.canCollect).length}`));
      const list = node('div', 'ranch-animals'); if (!animals.length) list.appendChild(node('div', 'friend-muted', '当前栏舍为空，可按已保存优先级补栏。'));
      for (const animal of animals) { const animalId = Number(animal.animal_id ?? animal.animalId), meta = animalOptions().find(a => a.animalId === animalId), stage = Number(animal.stage), harvest = animal.can_harvest ?? animal.canHarvest, stageName = ({ 1: '幼崽', 2: '成长中', 3: '生产中', 4: '成熟', 5: '可收取' })[stage] || `阶段 ${animal.stage ?? '—'}`; const row = node('div', 'ranch-animal'); row.append(node('span', '', `${meta?.name || state.animalCatalog.get(animalId)?.name || `动物 ${animalId}`} · ${stageName}`), node('small', harvest ? 'animal-ready' : 'friend-muted', `${(animal.can_deliver ?? animal.canDeliver) && !animal.producing ? '待接生 · ' : ''}${harvest ? '可收取 · ' : ''}实例 ${animal.animal_inst_id ?? animal.animalInstId ?? '—'}`)); list.appendChild(row); }
      card.appendChild(list); el.appendChild(card);
    }
  }
  function renderPasture(ps) {
    ps = ps || { status: 'not-loaded' }; const ranches = Array.isArray(ps.ranches) ? ps.ranches : [], ready = pastureReady(ps), writable = pastureWritable(ps), busy = !!pasturePending();
    $('#pastureCount').textContent = ps.status === 'ready' ? `${ranches.length} 个栏舍 · ${ranches.reduce((n, r) => n + (Number(r.animal_count ?? r.animalCount) || r.animals?.length || 0), 0)} 只动物` : '—';
    let message = ps.status === 'ready' ? `同步 ${fmtTime(ps.fetchedAt)} · 动物库存${inventoryReady(ps) ? '已读取' : '未就绪'}` : ps.status === 'error' ? `牧场读取失败：${ps.error || '请刷新'}` : '牧场尚未加载，请主动刷新。'; if (state.value?.needsReconcile) message += ' · 写操作待核对，请先刷新；只读预览仍可用'; if (state.friendDisconnected) message += ' · 实时连接已中断';
    $('#pastureStatus').textContent = message; $('#pastureStatus').classList.toggle('friend-error', ps.status === 'error' || !!state.friendDisconnected); $('#pastureAccount').textContent = ps.account ? `当前账号：${typeof ps.account === 'string' ? ps.account : ps.account.name || ps.selfGid} · GID ${ps.selfGid}${inventoryReady(ps) ? ` · 金券 ${Number(ps.balances?.[1007] || 0)} · 库存牧草 ${Number(ps.grassStock || 0)}` : ''}` : '';
    $('#pastureRefreshBtn').disabled = busy;
    if (ps.status === 'not-loaded' || !ps.ranches) { $('#pastureRanches').textContent = ''; $('#pastureRanches').appendChild(node('div', 'muted-empty', '牧场未加载；不会用模拟农田或假动物填充。')); } else renderRanches($('#pastureRanches'), ranches);
    const fs = ps.friends || {}, items = pastureFriends(ps), targets = pastureTargets(ps), list = $('#pastureFriendList'); $('#pastureFriendCount').textContent = fs.status === 'ready' ? `${targets.length} 位好友` : '—'; $('#pastureFriendStatus').textContent = fs.status === 'ready' ? `同步 ${fmtTime(fs.fetchedAt)} · 后端逐个检查真实栏舍，摘要仅供参考` : fs.status === 'error' ? `牧场好友读取失败：${fs.error || '请刷新牧场'}` : '尚未读取牧场好友，不等于没有好友。';
    const quota = Array.isArray(ps.quota) ? ps.quota : []; $('#pastureQuota').textContent = quota.length ? quota.map(q => `${q.op_id ?? q.opId ?? q.id}：剩余 ${q.remaining_times ?? q.remainingTimes ?? q.remaining ?? '—'}`).join(' · ') : '牧场操作额度尚未加载'; list.textContent = '';
    if (fs.status !== 'ready') list.appendChild(node('div', 'muted-empty', '请刷新牧场获取独立的牧场好友列表。'));
    else { const query = $('#pastureFriendSearch').value.trim().toLocaleLowerCase(), visible = items.filter(f => !query || String(f.name || '').toLocaleLowerCase().includes(query) || String(f.gid).includes(query)); if (!visible.length) list.appendChild(node('div', 'muted-empty', '没有匹配的牧场好友。'));
      for (const f of visible) { const self = isSelfFriend(f, ps), row = node('article', `friend-row${self ? ' friend-self' : ''}`), info = node('div', 'friend-info'), heading = node('div', 'friend-name'); heading.appendChild(node('strong', '', f.name || '未命名好友')); if (self) heading.appendChild(node('span', 'self-badge', '自己')); const summary = f.bigFarmStatus || {}, steal = summary.steal_lot_count ?? summary.stealLotCount, help = summary.help_count ?? summary.helpCount; info.append(heading, node('div', 'friend-muted', `GID ${f.gid}`), node('div', 'friend-summary', f.bigFarmStatus ? `可摘 ${steal ?? 0} · 可帮忙 ${help ?? 0}` : '摘要未提供；以实际栏舍查询为准')); row.appendChild(info); const actions = node('div', 'friend-row-actions');
        if (!self) for (const [type, label] of [['pasture-visit', '查看'], ['pasture-friends-clean', '清理'], ['pasture-friends-steal', '摘取']]) { const button = node('button', 'btn btn-small btn-ghost', label); button.disabled = busy || !validId(f.gid) || !ready || (type !== 'pasture-visit' && !writable); button.addEventListener('click', () => { void pastureCommand(type, f.gid); }); actions.appendChild(button); } row.appendChild(actions); list.appendChild(row); }
    }
    const preview = ps.preview, key = preview ? `${preview.gid}:${preview.fetchedAt}` : '', show = !!preview && key !== state.closedPasturePreview; $('#pasturePreview').classList.toggle('hidden', !show); if (show) { state.currentPasturePreview = key; $('#pasturePreviewTitle').textContent = `好友牧场预览 · ${preview.name || '未命名好友'}（GID ${preview.gid}）`; $('#pasturePreviewStatus').textContent = `缓存时间 ${fmtTime(preview.fetchedAt)}`; renderRanches($('#pasturePreviewRanches'), Array.isArray(preview.ranches) ? preview.ranches : []); }
    const catalog = animalOptions(); syncSelect($('#animalBuySelect'), catalog.map(a => ({ value: a.animalId, text: `${a.name || a.animalId} · ${husbandryName(a.husbandryType)} · 库存 ${a.count}${a.unlocked ? '' : ' · 未解锁'}` })), '选择要购买的动物'); renderBuy();
  }
  function buySelection() { const animal = animalOptions().find(a => String(a.animalId) === $('#animalBuySelect').value), count = Number($('#animalBuyCount').value), price = Number(animal?.price); return { animal, count, price, valid: !!animal && animal.unlocked === true && validId(animal.goodsId) && animal.price != null && Number.isFinite(price) && price >= 0 && Number.isSafeInteger(count) && count >= 1 && count <= 20 && Number.isSafeInteger(price * count) }; }
  function renderBuy() { const { animal, count, price, valid } = buySelection(); $('#animalBuyTotal').textContent = !animal ? '选择动物查看总价' : !valid ? animal.unlocked !== true ? '当前动物未解锁，不能购买' : '请输入 1–20 的整数数量并读取有效价格' : `总价 ${price * count} 金券（${price} × ${count}）`; $('#animalBuyBtn').textContent = valid ? `购买所选动物（${count} 只 · ${price * count} 金券）` : '购买所选动物'; $('#animalBuyBtn').disabled = !valid || !pastureWritable(state.value?.pastureState) || pasturePending(); }
  async function pastureCommand(type, gid, extra = {}) {
    try {
      if (!pastureTypes.has(type) || pasturePending()) return; const ps = state.value?.pastureState;
      if (type !== 'pasture-refresh' && !pastureReady(ps)) { showNotice('请先连接并成功刷新牧场。', true); return; }
      if (!pastureReads.has(type) && !pastureWritable(ps)) { showNotice(state.value?.needsReconcile ? '请先刷新核对上次操作结果，暂不能执行写操作。' : '牧场身份尚未就绪，请刷新。', true); return; }
      if (gid != null && ps?.friends?.status !== 'ready') { showNotice('牧场好友列表尚未读取成功，请刷新牧场。', true); return; }
      if (gid != null) { const f = pastureFriends(ps).find(f => gidKey(f.gid) === gidKey(gid)); if (!validId(gid) || !f || isSelfFriend(f, ps)) { showNotice('请选择有效的其他牧场好友。', true); return; } }
      else if (type === 'pasture-visit') { showNotice('查看牧场必须指定好友。', true); return; }
      if (type.startsWith('pasture-friends-') && (ps?.friends?.status !== 'ready' || !pastureTargets(ps).length)) { showNotice('请先刷新牧场好友列表。', true); return; }
      if (type === 'pasture-place' && (state.preferenceDirty.animal || !hasPriorityPolicy('animal'))) { showNotice('请先添加并保存动物优先设置。', true); return; }
      if (['pasture-place', 'pasture-feed', 'pasture-manage'].includes(type) && !inventoryReady(ps)) { showNotice('动物/饲料库存未读取成功，请刷新牧场。', true); return; }
      if (type === 'pasture-buy' && !buySelection().valid) { showNotice('请选择已解锁动物，并输入 1–20 的整数数量。', true); return; }
      const payload = { commandId: crypto.randomUUID(), type, ...extra }; if (gid != null) payload.gid = Number(gid); if (type === 'pasture-visit') state.closedPasturePreview = null;
      state.pastureBusy = true; renderPasture(ps); renderWriteGuards(); await post('/api/commands', payload);
    } catch (e) { showNotice(`牧场操作失败：${e.message}`, true); } finally { state.pastureBusy = false; renderPasture(state.value?.pastureState); renderWriteGuards(); }
  }
  function renderLands(lands) {
    const el = $('#landsGrid'); el.textContent = ''; if (!lands.length) { const d = node('div', 'empty-state'); d.append(node('div', 'empty-icon', '◌'), node('h3', '', '等待农场状态'), node('p', '', 'Live 未连接或还没有可用快照。')); el.appendChild(d); return; }
    lands.forEach((l, i) => { const p = l.plant || {}, dead = p.currentPhase === 7, card = node('article', `land-card ${!l.unlocked ? 'locked' : ''} ${p.needCare ? 'needs-care' : ''} ${dead ? 'dead' : ''}`), head = node('div', 'land-head'); head.append(node('span', '', `地块 ${l.id ?? i + 1}`), node('span', 'land-level', l.unlocked ? `Lv.${l.level || 1}` : '未解锁')); const meta = node('div', 'crop-meta'); meta.append(node('span', '', !l.unlocked || !p.id ? '—' : dead ? '请清理' : p.isRipe ? '已成熟' : '生长中'), node('span', '', dead ? '优先清理' : p.needWater ? '需浇水' : p.needWeed ? '有杂草' : p.needInsect ? '有害虫' : '状态良好')); card.append(head, node('div', 'crop-visual', l.unlocked ? dead ? '🥀' : iconFor(p) : '🔒'), node('div', 'crop-name', l.unlocked ? dead ? '枯死作物' : fmtCrop(p) : '暂未开放'), meta); const countdown = fmtCountdown(p.ripeAt); if (countdown && !p.isRipe && !dead) card.appendChild(node('div', 'countdown', `成熟倒计时 ${countdown}`)); if (p.isRipe && !dead) card.appendChild(node('span', 'tag', '可收获')); if (l.masterLandId) card.appendChild(node('small', 'friend-muted', `副产地 · 主地 ${l.masterLandId}`)); el.appendChild(card); });
  }
  function activityEntries(jobs, logs, scope = null) {
    const jobScope = job => ['farm','pasture','system'].includes(job.scope) ? job.scope
      : job.type?.startsWith('pasture-') ? 'pasture'
      : (job.type?.startsWith('friend-') || ['farm-manage','friends-refresh','refresh','care','care-self','plant','plant-priority','harvest','remove-dead'].includes(job.type)) ? 'farm' : 'system';
    if (scope) {
      jobs = jobs.filter(job => jobScope(job) === scope);
      logs = logs.filter(log => (log.scope || 'system') === scope);
    }
    const entries = [
      ...jobs.map(job => ({ kind: 'job', key: 'job:' + job.id, at: job.finishedAt || job.startedAt || job.createdAt, job })),
      ...logs.map((log, index) => ({ kind: 'log', key: 'log:' + index, at: log.at, log })),
    ];
    const time = entry => { const n = Date.parse(entry.at); return Number.isFinite(n) ? n : 0; };
    return entries.sort((a, b) => time(b) - time(a)).slice(0, 200);
  }
  function renderActivity(jobs, logs) {
    const el = $('#logsList');
    state.activityScroll ||= { farm: 0, pasture: 0, system: 0 };
    if (state.activityScope) state.activityScroll[state.activityScope] = el.scrollTop;
    const scope = /^#\/pasture\/?$/.test(window.location.hash) ? 'pasture'
      : /^#\/settings\/?$/.test(window.location.hash) ? 'system' : 'farm';
    state.activityScope = scope;
    const names = { farm: '农场', pasture: '牧场', system: '系统' };
    $('#activityTitle').textContent = names[scope] + '任务与日志';
    const entries = activityEntries(jobs, logs, scope);
    $('#jobCount').textContent = entries.filter(entry => entry.kind === 'job').length + ' 条任务';
    el.textContent = '';
    if (!entries.length) { el.appendChild(node('div', 'muted-empty', '暂无' + names[scope] + '任务或运行日志')); return; }
    for (const entry of entries) {
      const row = node('div', 'activity-entry ' + (entry.kind === 'job' ? 'activity-job' : 'activity-log'));
      const heading = node('div', 'activity-entry-heading');
      heading.append(node('time', 'log-time', fmtTime(entry.at)));
      if (entry.kind === 'job') {
        const job = entry.job, result = job.result;
        heading.append(node('span', 'activity-kind', '任务'), node('span', 'activity-job-name', labels[job.type] || job.type || '任务'));
        const partial = job.status === 'succeeded' && result?.errors?.length > 0;
        heading.append(node('span', 'activity-status ' + (partial ? 'partial' : job.status || ''), partial ? '部分完成' : statusLabels[job.status] || job.status || '状态未知'));
        const text = [job.error, result?.message || (result?.count != null ? '数量 ' + result.count + ' 项' : '')].filter(Boolean).join(' · ');
        row.append(heading);
        if (text) row.append(node('div', 'activity-message', text));
        for (const error of (result?.errors || []).slice(0,20)) row.append(node('div', 'activity-error-detail', [error.name || (error.gid ? '好友 ' + error.gid : ''), error.code ? '[' + error.code + ']' : '', error.message || '操作未完成'].filter(Boolean).join(' · ')));
        if (result?.errors?.length > 20) row.append(node('div', 'activity-error-detail', '另有 ' + (result.errors.length - 20) + ' 条未完成记录'));
      } else {
        heading.append(node('span', 'activity-kind', '日志'));
        row.append(heading, node('div', 'activity-message', entry.log.message || ''));
      }
      el.appendChild(row);
    }
    el.scrollTop = state.activityScroll[scope];
  }
  async function request(url, options = {}) { const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-Farm-Request': '1', ...(options.headers || {}) } }); if (!res.ok) { let message = `请求失败（${res.status}）`; try { const body = await res.json(); message = body.error || body.message || message; } catch (_) {} throw new Error(message); } return res.status === 204 ? null : res.json(); }
  async function load() { try { render(await request('/api/state')); } catch (e) { state.friendDisconnected = true; renderFriends(state.value?.friendState); renderPasture(state.value?.pastureState); renderWriteGuards(); showNotice(`网络失联：${e.message}`, true); $('#connectionState').textContent = '无法连接'; } }
  async function post(url, body, refresh = true) { try { const result = await request(url, { method: 'POST', body: JSON.stringify(body) }); if (refresh) await load(); showNotice('请求已提交，等待运行结果。'); return result; } catch (e) { showNotice(`操作失败：${e.message}`, true); throw e; } }
  async function command(type) {
    if (state.busy) return; if (state.value?.needsReconcile) { showNotice('请先刷新核对上次操作结果，暂不能执行写操作。', true); return; }
    if (['care','farm-manage'].includes(type) && !friendWritable(state.value?.friendState)) { showNotice('务农包含好友操作，请先刷新好友并确认账号身份。', true); return; }
    if (type === 'plant-priority' && (state.preferenceDirty.seed || !hasPriorityPolicy('seed'))) { showNotice('请先添加并保存种子优先设置。', true); return; }
    const payload = { commandId: crypto.randomUUID(), type }; if (type === 'plant') { const seed = selectedSeed(); if (!seed) { showNotice('所选种子没有库存或不可种植；请明确选择其它种子，不会自动换种。', true); return; } payload.seedId = Number(seed.seed); }
    state.busy = true; renderSeeds(state.value?.seeds, state.value?.monitor, state.value?.inventory); renderWriteGuards(); try { await post('/api/commands', payload); } finally { state.busy = false; renderSeeds(state.value?.seeds, state.value?.monitor, state.value?.inventory); renderWriteGuards(); }
  }
  async function updateMonitor(scope, toggleChange = false) {
    if (state.monitorUpdating[scope]) return;
    const saved = state.value?.monitors?.[scope] || {}, draft = state.monitorDraft[scope];
    const enabled = toggleChange ? $('#' + scope + 'MonitorToggle').checked : !!saved.enabled;
    const stopping = toggleChange && !enabled;
    const reason = enabled ? monitorBlockReason(scope) : '';
    if (reason) { showNotice(reason, true); renderMonitorPanels(); return; }
    const intervalSec = Number(draft.intervalSec);
    if (!stopping && (!Number.isInteger(intervalSec) || intervalSec < 60 || intervalSec > 3600)) { showNotice('周期应为60–3600秒的整数。', true); renderMonitorPanels(); return; }
    const payload = stopping ? { enabled: false } : { enabled, intervalSec, friendsEnabled: !!draft.friendsEnabled };
    if (!stopping && scope === 'farm' && selectedSeed()) payload.seedId = Number(selectedSeed().seed);
    if (!stopping && scope === 'pasture') payload.feedEnabled = !!draft.feedEnabled;
    state.monitorUpdating[scope] = true; renderMonitorPanels();
    try { await post('/api/monitor/' + scope, payload, false); state.monitorDirty[scope] = false; await load(); }
    catch (_) { /* post displays the real API error; keep other scene and drafts unchanged. */ }
    finally { state.monitorUpdating[scope] = false; if (state.value) render(state.value); }
  }
  function bind() {
    $('#friendsRefreshBtn').addEventListener('click', () => { void friendCommand('friends-refresh'); }); $('#friendStealAllBtn').addEventListener('click', () => { void friendCommand('friend-steal'); }); $('#friendCareAllBtn').addEventListener('click', () => { void friendCommand('friend-care'); }); $('#friendSearch').addEventListener('input', () => renderFriends(state.value?.friendState)); $('#friendPreviewClose').addEventListener('click', () => { state.closedFriendPreview = state.currentFriendPreview; $('#friendPreview').classList.add('hidden'); });
    $('#seedSelect').addEventListener('change', () => { state.manualSeed = $('#seedSelect').value; renderSeeds(state.value?.seeds, state.value?.monitor, state.value?.inventory); renderWriteGuards(); });
    $('#connectBtn').addEventListener('click', () => { void post('/api/connect', {}).catch(() => {}); }); $('#refreshBtn').addEventListener('click', () => { if (/^#\/pasture\/?$/.test(window.location.hash)) void pastureCommand('pasture-refresh'); else void post('/api/refresh', {}).catch(() => {}); });
    document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { void command(button.dataset.command).catch(() => {}); }));
    for (const group of ['seed', 'animal']) { $('#' + group + 'PriorityAdd').addEventListener('click', () => addPriority(group)); $('#' + group + 'PrioritySelect').addEventListener('change', renderPreferences); $('#' + group + 'Fallback').addEventListener('change', () => { state.preferenceDraft[group + 'Fallback'] = $('#' + group + 'Fallback').checked; markPreferenceDirty(group); }); $('#save' + (group === 'seed' ? 'Seed' : 'Animal') + 'Preferences').addEventListener('click', () => { void savePreferences(group); }); }
    $('#allowAnimalPurchase').addEventListener('change', () => { state.preferenceDraft.allowAnimalPurchase = $('#allowAnimalPurchase').checked; markPreferenceDirty('animal'); }); $('#maxAnimalSpendPerCycle').addEventListener('input', () => { state.preferenceDraft.maxAnimalSpendPerCycle = Number($('#maxAnimalSpendPerCycle').value); markPreferenceDirty('animal'); });
    $('#pastureRefreshBtn').addEventListener('click', () => { void pastureCommand('pasture-refresh'); }); document.querySelectorAll('[data-pasture-command]').forEach(button => button.addEventListener('click', () => { void pastureCommand(button.dataset.pastureCommand); })); $('#pastureFriendSearch').addEventListener('input', () => renderPasture(state.value?.pastureState)); $('#pasturePreviewClose').addEventListener('click', () => { state.closedPasturePreview = state.currentPasturePreview; $('#pasturePreview').classList.add('hidden'); });
    $('#animalBuySelect').addEventListener('change', renderBuy); $('#animalBuyCount').addEventListener('input', renderBuy); $('#animalBuyBtn').addEventListener('click', () => { const { animal, count, valid } = buySelection(); if (valid) void pastureCommand('pasture-buy', null, { animalId: animal.animalId, count, expectedUnitPrice: Number(animal.price) }); });
    for (const scope of ['farm','pasture']) {
      $('#' + scope + 'MonitorToggle').addEventListener('change', () => { void updateMonitor(scope, true); });
      $('#' + scope + 'MonitorApply').addEventListener('click', () => { void updateMonitor(scope); });
      $('#' + scope + 'MonitorInterval').addEventListener('input', () => { state.monitorDraft[scope].intervalSec = $('#' + scope + 'MonitorInterval').value; state.monitorDirty[scope] = true; renderMonitorPanels(); });
      $('#' + scope + 'MonitorFriends').addEventListener('change', () => { state.monitorDraft[scope].friendsEnabled = $('#' + scope + 'MonitorFriends').checked; state.monitorDirty[scope] = true; renderMonitorPanels(); });
    }
    $('#pastureMonitorFeed').addEventListener('change', () => { state.monitorDraft.pasture.feedEnabled = $('#pastureMonitorFeed').checked; state.monitorDirty.pasture = true; renderMonitorPanels(); });
  }
  function events() { if (!window.EventSource) return; const es = new EventSource('/api/events'); state.source = es; es.addEventListener('state', event => { try { state.friendDisconnected = false; render(JSON.parse(event.data)); } catch (_) { state.friendDisconnected = true; renderFriends(state.value?.friendState); renderPasture(state.value?.pastureState); renderWriteGuards(); showNotice('收到无法解析的状态事件。', true); } }); es.onerror = () => { state.friendDisconnected = true; $('#runtimeSummary').textContent = '实时连接中断'; $('#logHint').textContent = '实时连接中断'; renderFriends(state.value?.friendState); renderPasture(state.value?.pastureState); renderWriteGuards(); }; es.onopen = () => { $('#logHint').textContent = '实时'; }; }
  window.addEventListener('hashchange', () => renderActivity(state.value?.jobs || [], state.value?.logs || []));
  bind(); load(); events();
})();
