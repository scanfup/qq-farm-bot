# -*- coding: utf-8 -*-
"""精准扫描：只看 json，抽 URL/域名/协议线索，抽配置表结构"""
import json, os, sys, io, re, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HAR = os.path.join(os.path.dirname(__file__), '..', 'servicewechat.com.har')
OUT = os.path.join(os.path.dirname(__file__), '..', 'out', 'json')
os.makedirs(OUT, exist_ok=True)

with open(HAR, 'r', encoding='utf-8') as f:
    har = json.load(f)
entries = har['log']['entries']

# 收集所有 json body
docs = []
for i, e in enumerate(entries):
    c = e['response'].get('content', {})
    if 'json' not in (c.get('mimeType') or ''):
        continue
    txt = c.get('text') or ''
    if not txt:
        continue
    try:
        j = json.loads(txt)
    except Exception:
        continue
    docs.append((i, e['request']['url'], j, txt))

out = []
out.append('json docs = %d' % len(docs))

# ---- URL / 域名线索 ----
urlre = re.compile(r'https?://[a-zA-Z0-9\.\-_/:%?=&#]{4,120}')
domre = re.compile(r'\b([a-z0-9\-]+\.)+(qq|com|cn|net|org|com\.cn)\b')
urls = collections.Counter()
doms = collections.Counter()
for i, u, j, txt in docs:
    for m in urlre.findall(txt):
        urls[m] += 1
    for m in domre.findall(txt):
        pass
    for m in re.finditer(domre, txt):
        doms[m.group(0)] += 1

out.append('')
out.append('=== URLs found in json bodies ===')
for u, c in urls.most_common(80):
    out.append('[%4d] %s' % (c, u))
out.append('')
out.append('=== DOMAINS (not nqf cdn) ===')
for d, c in doms.most_common(60):
    out.append('[%4d] %s' % (c, d))

# ---- 顶层结构 ----
out.append('')
out.append('=== TOP-LEVEL SHAPE of each json ===')
for i, u, j, txt in docs:
    if isinstance(j, dict):
        ks = list(j.keys())[:14]
        shape = 'dict(%d) %s' % (len(j), ks)
    elif isinstance(j, list):
        shape = 'list(%d)' % len(j)
        if j and isinstance(j[0], dict):
            shape += ' item0keys=%s' % list(j[0].keys())[:14]
    else:
        shape = type(j).__name__
    out.append('#%-4d %-8s %s' % (i, len(txt), u.replace('https://cdn-resource.nqf.qq.com/release/remote/', '~/')))
    out.append('        %s' % shape)

txt = '\n'.join(out)
open(os.path.join(OUT, '..', 'json_scan.txt'), 'w', encoding='utf-8').write(txt)
print(txt[:14000])

# 落盘体积较大的 json 便于后续细读
saved = 0
for i, u, j, txt in sorted(docs, key=lambda x: -len(x[3]))[:40]:
    name = re.sub(r'[^a-zA-Z0-9]', '_', u.split('/release/remote/')[-1])[:90]
    with open(os.path.join(OUT, 'e%03d_%s' % (i, name)), 'w', encoding='utf-8') as f:
        f.write(txt)
    saved += 1
print('\n[saved] %d json bodies -> %s' % (saved, OUT))
