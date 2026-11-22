# -*- coding: utf-8 -*-
"""提取 POST 请求明细 + 探测 HAR 内是否含 WebSocket 消息"""
import json, os, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HAR = os.path.join(os.path.dirname(__file__), '..', 'servicewechat.com.har')
OUT = os.path.join(os.path.dirname(__file__), '..', 'out')
os.makedirs(OUT, exist_ok=True)

with open(HAR, 'r', encoding='utf-8') as f:
    har = json.load(f)

log = har['log']
print('[keys] log keys =', list(log.keys()))
print('[keys] entry[0] keys =', list(log['entries'][0].keys()))
print('[ws] _webSocketMessages present in any entry?')
cnt_ws = 0
for i, e in enumerate(log['entries']):
    if '_webSocketMessages' in e:
        cnt_ws += 1
        if cnt_ws <= 3:
            print('  entry#%d ws msgs=%d' % (i, len(e['_webSocketMessages'])))
print('[ws] total entries with ws messages =', cnt_ws)

lines = []
lines.append('########## POST REQUESTS ##########')
for i, e in enumerate(log['entries']):
    req = e['request']
    if req['method'] != 'POST':
        continue
    lines.append('')
    lines.append('--- entry#%d ---' % i)
    lines.append('startedDateTime: %s' % e.get('startedDateTime'))
    lines.append('url: %s' % req['url'])
    lines.append('headers:')
    for h in req['headers']:
        lines.append('    %s: %s' % (h['name'], h['value']))
    pd = req.get('postData')
    if pd:
        lines.append('postData.mimeType: %s' % pd.get('mimeType'))
        lines.append('postData.text: %s' % str(pd.get('text'))[:4000])
    resp = e['response']
    lines.append('resp.status: %s' % resp['status'])
    lines.append('resp.headers:')
    for h in resp['headers']:
        lines.append('    %s: %s' % (h['name'], h['value']))
    lines.append('resp.body: %s' % str(resp.get('content', {}).get('text'))[:3000])

txt = '\n'.join(lines)
with open(os.path.join(OUT, 'post_detail.txt'), 'w', encoding='utf-8') as f:
    f.write(txt)
print(txt[:6000])
