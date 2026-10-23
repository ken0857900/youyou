"""⚠️ 只给开发用：把前端 mock.js 的假数据灌进本地数据库，方便接 API。
比赛 demo 必须用真实收集的文章，规则禁止造假测试数据——上线/录 demo 前先重跑 schema.sql 清空。
用法（仓库根目录）：python backend/seed.py   （会先执行 schema.sql 清空重建）"""
import json
import subprocess
import sys
from pathlib import Path

from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
from app.db import connect  # noqa: E402

MOCK = (ROOT / 'website/frontend/src/data/mock.js').as_uri()
JS = f"import * as m from '{MOCK}'; console.log(JSON.stringify({{P: m.PERSONS, A: m.ARTICLES, J: m.JOBS, W: m.WISH_REQUESTS, N: m.NOTIFICATIONS, C: m.ACCOUNTS}}))"
d = json.loads(subprocess.run(['node', '--input-type=module', '-e', JS], capture_output=True, check=True, encoding='utf-8').stdout)

with connect() as c:
    c.execute((Path(__file__).parent / 'schema.sql').read_text(encoding='utf-8'))
    for p in d['P']:
        rest = {k: v for k, v in p.items() if k not in ('id', 'name', 'schoolTier', 'major')}
        c.execute('INSERT INTO persons VALUES (%s,%s,%s,%s,%s)', (p['id'], p['name'], p['schoolTier'], p['major'], Jsonb(rest)))
    for a in d['A']:
        c.execute('INSERT INTO articles (id, author_id, type, status, category, title, summary, content, tags, date, stars, bookmarks, views_seed) '
                  'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                  (a['id'], a['authorId'], a['type'], a['status'], a['category'], a['title'], a['summary'], a['content'],
                   a['tags'], a['date'], a['stars'], a['bookmarks'], 0))  # 热门只看真点击（10/20 归零）
        if dp := a.get('decisionPoint'):
            c.execute(f'INSERT INTO decision_points (article_id, {", ".join(chr(34) + k + chr(34) for k in dp)}) '
                      f'VALUES (%s, {", ".join(["%s"] * len(dp))})', [a['id'], *dp.values()])
    co = d['C']['company']
    cid = c.execute('INSERT INTO companies (name, approved) VALUES (%s, %s) RETURNING id', (co['name'], co['approved'])).fetchone()['id']
    for j in d['J']:
        c.execute('INSERT INTO jobs (id, company_id, company, official, title, city, salary, majors, decision_types, description, date, deadline) '
                  'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                  (j['id'], cid if j['company'] == co['name'] else None, j['company'], j['official'], j['title'], j['city'],
                   j['salary'], j['majors'], j['decisionTypes'], j['description'], j['date'], j['deadline']))
    acc = {}
    for role, x in d['C'].items():
        acc[role] = c.execute('INSERT INTO accounts (role, name, email, pku_verified, person_id, company_id) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id',
                              (role, x['name'], x['email'], x.get('pkuVerified', False), x.get('personId'),
                               cid if role == 'company' else None)).fetchone()['id']
    for w in d['W']:
        c.execute('INSERT INTO wish_requests (id, query, conditions, want_count, status, article_id) VALUES (%s,%s,%s,%s,%s,%s)',
                  (w['id'], w['query'], Jsonb(w['conditions']), w['wantCount'], w['status'], w.get('articleId')))
    for n in d['N']:  # 假通知都挂在访客账号上
        c.execute('INSERT INTO notifications (account_id, type, request_id, text, link, date, read) VALUES (%s,%s,%s,%s,%s,%s,%s)',
                  (acc['reader'], n['type'], n.get('requestId'), n['text'], n['link'], n['date'], n['read']))

print(f"seeded: {len(d['P'])} persons, {len(d['A'])} articles, {len(d['J'])} jobs")
