// 核实当前登录账号
import { Bridge } from './core.mjs';
import { parse, fields, num, str } from './farm.mjs';

const b = new Bridge({ port: Number(process.env.CDP_PORT || 62000) });
try {
  await b.ensure({ onLog: () => { } });
  const p = await b.ping();
  console.log('[openid]', p.status.openid);
  console.log('[cseq]', p.status.cseq);
  console.log('[url]', p.status.url);

  // 心跳里的 gid 就是自己 —— 直接从心跳解一次
  const gid = await b.detectGid({ onLog: (m) => console.log('[gid]', m), waitMs: 40000 });
  console.log('[自身 gid]', gid);

  // 拉好友列表，看这个 gid 在列表里的名字与位置
  const r = await b.call('gamepb.friendpb.FriendService', 'GetAll', Buffer.alloc(0));
  const rep = parse(r.body);
  const list = fields(rep, 1).map(bs => {
    const f = parse(bs);
    return { gid: num(f, 1), name: str(f, 3), lv: num(f, 6) };
  });
  console.log(`\n[好友 ${list.length} 个]`);
  for (const f of list) {
    const tag = f.gid === gid ? '  ★ 这是自己' : '';
    console.log(`  ${String(f.gid).padStart(11)}  ${String(f.name).padEnd(18)} lv${f.lv}${tag}`);
  }

  // 自家土地：确认这是谁的号
  const ar = await b.call('gamepb.plantpb.PlantService', 'AllLands', Buffer.alloc(0));
  const lands = fields(parse(ar.body), 1);
  let unlocked = 0, planted = 0;
  for (const bs of lands) {
    const li = parse(bs);
    if (num(li, 2) === 0) continue;
    unlocked++;
    const pb = fields(li, 10)[0];
    if (pb && num(parse(pb), 1)) planted++;
  }
  console.log(`\n[自家农场] 已解锁 ${unlocked} 块，其中 ${planted} 块有作物`);
} catch (e) {
  console.log('[FAIL]', e.message);
} finally {
  b.close();
  setTimeout(() => process.exit(0), 200);
}
