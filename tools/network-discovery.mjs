// Resolve an existing game connection without script offsets or paused execution.
// This expression only reads SystemJS exports; it never imports/initializes modules.
export const discoverNetwork = `(() => {
  const system = globalThis.System;
  if (!system || typeof system.get !== 'function') return { ok: false, reason: '没有可用的 SystemJS 注册表' };
  const oops = system.get('chunks:///_virtual/Oops.ts')?.oops;
  const control = oops?.netWebSocket;
  const channels = control?._channels;
  if (!channels || typeof channels.get !== 'function') return { ok: false, reason: '游戏网络通道尚未创建' };
  const net = channels.get(control.GAME_CHANNELID);
  if (!net || typeof net.send !== 'function' || typeof net.getState !== 'function' || typeof net.getServiceFunName !== 'function') {
    return { ok: false, reason: '未找到有效的游戏网络实例' };
  }
  const working = system.get('chunks:///_virtual/NetNode.ts')?.NetNodeState?.Working;
  if (typeof working !== 'number') return { ok: false, reason: '无法确认游戏网络状态定义' };
  const state = net.getState();
  if (state !== working) return { ok: false, reason: '游戏网络当前不在线', state };
  globalThis.__netInst = net;
  return { ok: true, source: 'SystemJS/Oops.netWebSocket', state };
})()`;
