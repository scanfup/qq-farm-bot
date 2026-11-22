# -*- coding: utf-8 -*-
"""深挖：Cookie 提取 / anticheatexpert 详情 / 资源内容关键词扫描 / initiator 脚本栈"""
import json, os, sys, io, re, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HAR = os.path.join(os.path.dirname(__file__), '..', 'servicewechat.com.har')
OUT = os.path.join(os.path.dirname(__file__), '..', 'out')
os.makedirs(OUT, exist_ok=True)

with open(HAR, 'r', encoding='utf-8') as f:
    har = json.load(f)
entries = har['log']['entries']
out = []

# ---------- 1. Cookie 全量提取 ----------
out.append('########## 1. COOKIE ##########')
cookies = collections.Counter()
for e in entries:
    for h in e['request']['headers']:
        if h['name'].lower() == 'cookie':
            cookies[h['value']] += 1
out.append('unique cookie header count = %d' % len(cookies))
for v, c in cookies.most_common(20):
    out.append('[x%d] len=%d  %s' % (c, len(v), v[:600]))
    out.append('')

# response set-cookie
out.append('--- set-cookie in responses ---')
sc = collections.Counter()
for e in entries:
    for h in e['response']['headers']:
        if h['name'].lower() == 'set-cookie':
            sc[h['value']] += 1
out.append('unique set-cookie = %d' % len(sc))
for v, c in sc.most_common(30):
    out.append('[x%d] %s' % (c, v[:400]))

# ---------- 2. anticheatexpert ----------
out.append('')
out.append('########## 2. ANTICHEAT ##########')
for i, e in enumerate(entries):
    u = e['request']['url']
    if 'anticheatexpert' not in u:
        continue
    out.append('--- entry#%d %s' % (i, u))
    req = e['request']
    out.append('headers: ' + json.dumps({h['name']: h['value'] for h in req['headers']}, ensure_ascii=False, indent=1))
    pd = req.get('postData')
    if pd:
        out.append('postData(%s): %s' % (pd.get('mimeType'), str(pd.get('text'))[:3000]))
    out.append('resp: %s' % str(e['response'].get('content', {}).get('text'))[:1500])
    out.append('')

# ---------- 3. initiator 脚本栈出现的脚本 URL ----------
out.append('')
out.append('########## 3. INITIATOR SCRIPT URLS ##########')
surls = collections.Counter()
def walk(fr, acc):
    for f in fr:
        u = f.get('url', '')
        if u:
            acc.add(u)
    p = fr[0].get('parent') if fr else None
    if p and isinstance(p, dict):
        walk(p.get('callFrames', []), acc)
for e in entries:
    st = e.get('_initiator', {}).get('stack')
    if st and 'callFrames' in st:
        s = set()
        walk(st['callFrames'], s)
        for u in s:
            surls[u] += 1
for u, c in surls.most_common(80):
    out.append('[x%d] %s' % (c, u))

# ---------- 4. 资源内容关键词扫描 ----------
out.append('')
out.append('########## 4. KEYWORD SCAN IN BODIES ##########')
KEYS = ['harvest', 'plant', 'water', 'weed', 'bug', 'steal', 'visit', 'friend', 'farmland',
        'seed', 'crop', 'sign=', 'signature', 'nonce', 'wss://', 'wx.request', 'tcb',
        'api.', 'gateway', 'login', 'token', 'openid', 'access_token', 'session',
        'encrypt', 'decrypt', 'md5', 'aes', 'rsa', 'protobuf', 'msgpack', 'seq', 'cmd']
hits = collections.Counter()
samples = collections.defaultdict(list)
for i, e in enumerate(entries):
    c = e['response'].get('content', {})
    txt = c.get('text') or ''
    if not isinstance(txt, str) or len(txt) < 20:
        continue
    low = txt.lower()
    for k in KEYS:
        if k in low:
            hits[k] += 1
            if len(samples[k]) < 4:
                idx = low.find(k)
                samples[k].append((i, e['request']['url'], txt[max(0, idx-160):idx+220]))

for k, c in hits.most_common():
    out.append('')
    out.append('=== KEY "%s" hit in %d bodies ===' % (k, c))
    for i, u, s in samples[k]:
        out.append('  entry#%d %s' % (i, u[:150]))
        out.append('    ...%s...' % s.replace('\n', ' ')[:400])

txt = '\n'.join(out)
open(os.path.join(OUT, 'deep.txt'), 'w', encoding='utf-8').write(txt)
print(txt[:20000])
