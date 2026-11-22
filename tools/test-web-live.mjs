// Real read-only smoke test: no Harvest/Plant/Farming commands are issued.
import { Bridge } from './core.mjs';
import { decodeAllLandsReply } from './farm.mjs';
const bridge = new Bridge();
try {
  await bridge.ensure({ onLog: message => console.log(message.replace(/wss?:\/\/\S+/g, '[local CDP]')) });
  if (process.argv.includes('--recovery')) {
    const firstSocket = bridge.ws;
    bridge.ctxId = 2147480000;
    await bridge.ensure();
    if (bridge.ws === firstSocket) throw new Error('未替换引用失效上下文的 CDP socket');
    const secondSocket = bridge.ws;
    bridge.ctxId = null; bridge.contexts = [];
    await bridge.ensure();
    if (bridge.ws === secondSocket) throw new Error('上下文列表丢失后没有重新订阅');
    console.log(JSON.stringify({ recovery: true, staleContextRecovered: true, emptyContextsRecovered: true, contextId: bridge.ctxId }));
  }
  const reply = await bridge.call('gamepb.plantpb.PlantService', 'AllLands', Buffer.alloc(0));
  const data = decodeAllLandsReply(reply.body);
  if (!data.lands.length) throw new Error('真实土地响应为空');
  const native = await bridge.evaluate(`(() => {
    const hex = ${JSON.stringify(reply.body.toString('hex'))};
    const bytes = new Uint8Array(hex.match(/../g).map(b => parseInt(b, 16)));
    const decoded = System.get('chunks:///_virtual/plantpb.ts').gamepb.plantpb.AllLandsReply.decode(bytes);
    return { lands: decoded.lands.length, unlocked: decoded.lands.filter(l => l.unlocked).length };
  })()`);
  if (native.lands !== data.lands.length || native.unlocked !== data.lands.filter(l => l.unlocked).length) throw new Error('外部解码与游戏原生解码不一致');
  console.log(JSON.stringify({ live: true, nativeDecoderAgrees: true, contextId: bridge.ctxId, bytes: reply.bodyLen, lands: data.lands.length, unlocked: data.lands.filter(l => l.unlocked).length, crops: [...new Set(data.lands.map(l => l.plant?.name).filter(Boolean))], receivedAt: new Date().toISOString() }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { bridge.close(); }
