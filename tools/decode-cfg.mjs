// 解密游戏配置：Base64 -> XOR -> JSON
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const XOR_KEY = Buffer.from('NQF_SHANGXIANDAMAI_#2026_SECURE', 'utf8');

function decodeConfig(text) {
  const b64 = String(text).trim();
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('不是规范 Base64');
  const enc = Buffer.from(b64, 'base64');
  const plain = Buffer.allocUnsafe(enc.length);
  for (let i = 0; i < enc.length; i++) plain[i] = enc[i] ^ XOR_KEY[i % XOR_KEY.length];
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

mkdirSync('out/cfg', { recursive: true });
for (const name of ['Plant', 'ItemInfo']) {
  try {
    const raw = readFileSync(`out/cfg/${name}.json`, 'utf8');
    const json = decodeConfig(raw);
    writeFileSync(`out/cfg/${name}.decoded.json`, json);
    const arr = JSON.parse(json);
    console.log(`\n[${name}] 解密成功  ${json.length} 字节  条目数=${Array.isArray(arr) ? arr.length : 'obj'}`);
    if (Array.isArray(arr) && arr.length) {
      console.log(`  字段: ${Object.keys(arr[0]).slice(0, 20).join(', ')}`);
      // Plant: 找白萝卜等
      const sample = arr.slice(0, 3);
      for (const s of sample) console.log('  样例:', JSON.stringify(s).slice(0, 260));
    }
  } catch (e) {
    console.log(`[${name}] 失败: ${e.message}`);
  }
}
