# -*- coding: utf-8 -*-
"""精确核查：appId 的字面值是否出现在 HAR；以及登录通道的真实形态"""
import json, os, sys, io, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HAR = os.path.join(os.path.dirname(__file__), '..', 'servicewechat.com.har')
with open(HAR, 'r', encoding='utf-8') as f:
    har = json.load(f)
entries = har['log']['entries']

print('=== A. appId 字面值 wx5306c5978fdb76e4 出现情况 ===')
VALUES = ['wx5306c5978fdb76e4', '1112386029', 'wxd44977328b36e647', '3167',
          'shortcloud.weixin.com', '1.14.2.13', '1.14.2.11']
hit = {v: [] for v in VALUES}
for i, e in enumerate(entries):
    req = e['request']
    blob = req['url']
    for h in req['headers']:
        blob += ' |%s: %s' % (h['name'], h['value'])
    for h in e['response']['headers']:
        blob += ' |%s: %s' % (h['name'], h['value'])
    txt = e['response'].get('content', {}).get('text') or ''
    if isinstance(txt, str):
        blob += ' |BODY:' + txt[:60000]
    for v in VALUES:
        if v in blob:
            hit[v].append(i)

for v in VALUES:
    n = len(hit[v])
    print('%-24s %s  first5=%s' % (v, ('★ %d 次' % n) if n else '  0 次', hit[v][:5]))

print()
print('=== B. 命中处的上下文（前 4 处） ===')
for i in hit['wx5306c5978fdb76e4'][:4]:
    e = entries[i]
    for h in e['request']['headers']:
        if 'wx5306c5978fdb76e4' in h['value']:
            print('#%-4d %-18s %s' % (i, h['name'], h['value'][:150]))
            break

print()
print('=== C. 版本号 1.14.2.13 出现处 ===')
for i in hit['1.14.2.13'][:3]:
    txt = entries[i]['request'].get('postData', {}).get('text') or ''
    m = re.search(r'.{70}1\.14\.2\.13.{70}', txt)
    print('#%-4d %s' % (i, (m.group(0) if m else '')[:220]))

print()
print('=== D. 是否为纯 HTTP 抓包的判定 ===')
print('entry 总类型:')
rt = {}
for e in entries:
    r = e.get('_resourceType', '?')
    rt[r] = rt.get(r, 0) + 1
for k, v in rt.items():
    print('   %-10s %d' % (k, v))
print('说明: 无 websocket 类型条目 → 本次抓包未记录任何 TCP/WSS 层握手')
