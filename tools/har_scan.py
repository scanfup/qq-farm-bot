# -*- coding: utf-8 -*-
"""HAR 全局盘点：host / path / method 分布，输出到 out/scan.txt"""
import json, sys, collections, os, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HAR = os.path.join(os.path.dirname(__file__), '..', 'servicewechat.com.har')
OUT = os.path.join(os.path.dirname(__file__), '..', 'out')
os.makedirs(OUT, exist_ok=True)

print('[load] reading har ...')
with open(HAR, 'r', encoding='utf-8') as f:
    har = json.load(f)

entries = har['log']['entries']
print('[load] entries =', len(entries))

hosts = collections.Counter()
paths = collections.Counter()
methods = collections.Counter()
mimes = collections.Counter()

for e in entries:
    req = e['request']
    url = req['url']
    try:
        from urllib.parse import urlparse
        p = urlparse(url)
        host = p.netloc
        path = p.path
    except Exception:
        host, path = '?', url
    hosts[host] += 1
    paths[host + path] += 1
    methods[req['method']] += 1
    mimes[e['response'].get('content', {}).get('mimeType', '?')] += 1

lines = []
lines.append('=== HOSTS (%d) ===' % len(hosts))
for h, c in hosts.most_common():
    lines.append('%7d  %s' % (c, h))

lines.append('')
lines.append('=== METHODS ===')
for m, c in methods.most_common():
    lines.append('%7d  %s' % (c, m))

lines.append('')
lines.append('=== MIME ===')
for m, c in mimes.most_common(30):
    lines.append('%7d  %s' % (c, m))

lines.append('')
lines.append('=== HOST+PATH top 300 ===')
for p, c in paths.most_common(300):
    lines.append('%7d  %s' % (c, p))

txt = '\n'.join(lines)
with open(os.path.join(OUT, 'scan.txt'), 'w', encoding='utf-8') as f:
    f.write(txt)
print(txt[:8000])
