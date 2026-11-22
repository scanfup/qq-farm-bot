# -*- coding: utf-8 -*-
"""核查 HAR 中是否存在登录链路相关证据"""
import json, os, sys, io, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HAR = os.path.join(os.path.dirname(__file__), '..', 'servicewechat.com.har')
with open(HAR, 'r', encoding='utf-8') as f:
    har = json.load(f)
entries = har['log']['entries']

print('=== 1. 全部 host 清单 ===')
hosts = {}
for e in entries:
    u = e['request']['url']
    h = u.split('/')[2] if '://' in u else u
    hosts[h] = hosts.get(h, 0) + 1
for h, c in sorted(hosts.items(), key=lambda x: -x[1]):
    print('%7d  %s' % (c, h))

print()
print('=== 2. 关键词全文检索（url + 全部 header 名/值） ===')
KEYS = ['login_buffer', 'yybadaccess', 'qrconnect', 'open.weixin', 'pcyyb',
        'gate-obt', 'gate.', '/prod/ws', 'wss://', 'appId', 'appid',
        'access_token', 'accesstoken', 'openid', 'open_id', 'code=',
        'wx.login', 'snssdk', 'oauth', 'authorize']
found = {k: 0 for k in KEYS}
samples = {k: [] for k in KEYS}
for i, e in enumerate(entries):
    req = e['request']
    blob = req['url']
    for h in req['headers']:
        blob += ' |%s: %s' % (h['name'], h['value'])
    for h in e['response']['headers']:
        blob += ' |%s: %s' % (h['name'], h['value'])
    low = blob.lower()
    for k in KEYS:
        if k.lower() in low:
            found[k] += 1
            if len(samples[k]) < 3:
                idx = low.find(k.lower())
                samples[k].append((i, blob[max(0, idx-90):idx+120]))

for k in KEYS:
    mark = '★HIT' if found[k] else '  none'
    print('%s  %-16s %d' % (mark, k, found[k]))
    for i, s in samples[k]:
        print('        #%d ...%s...' % (i, s.replace('\n', ' ')[:200]))

print()
print('=== 3. 是否存在服务端下发的 code / token 字段（响应体） ===')
cnt = 0
for i, e in enumerate(entries):
    txt = e['response'].get('content', {}).get('text') or ''
    if not isinstance(txt, str) or len(txt) < 5 or len(txt) > 4000:
        continue
    if re.search(r'"(code|token|login|openid|open_id|access_token|sid|uin)"\s*:', txt, re.I):
        cnt += 1
        print('#%-4d %s' % (i, e['request']['url'][:110]))
        print('      %s' % txt[:300].replace('\n', ' '))
print('命中数 =', cnt)

print()
print('=== 4. 时间线首尾与登录类请求位置 ===')
print('first:', entries[0]['startedDateTime'])
print('last :', entries[-1]['startedDateTime'])
print('entry#0 url:', entries[0]['request']['url'][:140])
print('entry#1 url:', entries[1]['request']['url'][:140])
