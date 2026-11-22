# -*- coding: utf-8 -*-
"""资源类型分布 + 非资源类请求全列 + JS/配置定位 + 时间线"""
import json, os, sys, io, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HAR = os.path.join(os.path.dirname(__file__), '..', 'servicewechat.com.har')
OUT = os.path.join(os.path.dirname(__file__), '..', 'out')
os.makedirs(OUT, exist_ok=True)

with open(HAR, 'r', encoding='utf-8') as f:
    har = json.load(f)
entries = har['log']['entries']

rt = collections.Counter()
ext = collections.Counter()
for e in entries:
    rt[e.get('_resourceType', '?')] += 1
    u = e['request']['url']
    tail = u.rsplit('/', 1)[-1]
    if '.' in tail:
        ext['.' + tail.rsplit('.', 1)[-1].split('?')[0][:8]] += 1
    else:
        ext['<none>'] += 1

out = []
out.append('=== _resourceType ===')
for k, v in rt.most_common():
    out.append('%6d  %s' % (v, k))
out.append('')
out.append('=== url ext ===')
for k, v in ext.most_common(40):
    out.append('%6d  %s' % (v, k))
out.append('')

# 时间线
ts = [e['startedDateTime'] for e in entries]
out.append('=== timeline ===')
out.append('first: %s' % ts[0])
out.append('last : %s' % ts[-1])
out.append('')

# 非 CDN 请求全列
out.append('=== NON-CDN requests (full) ===')
for i, e in enumerate(entries):
    u = e['request']['url']
    if 'cdn-resource.nqf.qq.com' in u:
        continue
    out.append('#%-4d %-6s %-8s %s' % (i, e['request']['method'], e.get('_resourceType'), u[:200]))
out.append('')

# 找所有 .js / .wasm / 主包
out.append('=== JS / WASM / script-type ===')
for i, e in enumerate(entries):
    u = e['request']['url']
    if u.endswith('.js') or '.js?' in u or u.endswith('.wasm') or e.get('_resourceType') == 'script':
        sz = e['response'].get('content', {}).get('size', 0)
        out.append('#%-4d %10s  %s' % (i, sz, u[:190]))
out.append('')

# 大 JSON（可能是配置表）
out.append('=== largest json responses ===')
js = [(e['response'].get('content', {}).get('size', 0), i, e['request']['url'])
      for i, e in enumerate(entries)
      if 'json' in e['response'].get('content', {}).get('mimeType', '')]
for sz, i, u in sorted(js, reverse=True)[:60]:
    out.append('#%-4d %10s  %s' % (i, sz, u[:180]))

txt = '\n'.join(out)
open(os.path.join(OUT, 'types.txt'), 'w', encoding='utf-8').write(txt)
print(txt)
