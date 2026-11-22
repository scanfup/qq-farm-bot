// Read-only friend acceptance: GetAll + Enter/Leave + return-home AllLands.
import { FarmApp } from '../web/service.mjs';
import { Bridge } from './core.mjs';
const bridge = new Bridge();
const rpc = bridge.call.bind(bridge);
let friendBody, visitBody;
bridge.call = async (service, method, ...args) => {
  const reply = await rpc(service, method, ...args);
  if (service === 'gamepb.friendpb.FriendService' && method === 'GetAll') friendBody = reply.body;
  if (service === 'gamepb.visitpb.VisitService' && method === 'Enter') visitBody = reply.body;
  return reply;
};
const app = new FarmApp({ bridge, journal: false });
async function nativeDecode(body, moduleName, type, expression) {
  return bridge.evaluate(`(() => {
    const hex = ${JSON.stringify(body.toString('hex'))};
    const bytes = new Uint8Array(hex.match(/../g).map(b => parseInt(b, 16)));
    const decoded = System.get('chunks:///_virtual/${moduleName}.ts').gamepb.${moduleName}.${type}.decode(bytes);
    return ${expression};
  })()`);
}
try {
  await app.connect();
  const before = app.friendService.state();
  if (before.status !== 'ready' || before.identitySource !== '游戏当前登录资料') throw new Error('真实好友或独立登录身份未加载');
  const nativeGids = await nativeDecode(friendBody, 'friendpb', 'GetAllReply', 'decoded.game_friends.map(f => Number(f.gid.toString()))');
  if (JSON.stringify([...nativeGids].sort()) !== JSON.stringify(before.friends.map(f => f.gid).sort())) throw new Error('好友列表与原生解码不一致');
  const target = before.friends.find(f => !f.isSelf && f.hasSummary);
  if (!target) throw new Error('当前没有可访问的其他好友');
  const job = app.submit('friend-visit', { gid: target.gid }, 'live-read-visit-001');
  await app.tail;
  if (job.status !== 'succeeded') throw new Error(job.error);
  const after = app.friendService.state();
  const nativeLands = await nativeDecode(visitBody, 'visitpb', 'EnterReply', 'decoded.lands.map(l => ({ id: Number(l.id.toString()), unlocked: !!l.unlocked }))');
  if (JSON.stringify(nativeLands) !== JSON.stringify(after.preview.lands.map(l => ({id:l.id,unlocked:l.unlocked})))) throw new Error('好友土地与原生解码不一致');
  if (app.friendService.activeGid) throw new Error('没有确认离开好友农场');
  console.log(JSON.stringify({ live: true, nativeDecoderAgrees: true, account: after.account, friends: after.friends.filter(f=>!f.isSelf).length, visit: { gid: target.gid, name: target.name, lands: after.preview.lands.length }, returnedHome: true, ownLands: app.snapshot.lands.length, quota: after.quota, writesIssued: false }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await app.close(); }
