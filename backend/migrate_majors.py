# 已有决策点的专业改成固定大类（本机／服务器都跑这支；可重复跑）
import sys
sys.path.insert(0, 'backend')
from app.db import connect
from app import search as S
with connect() as c:
    rows = c.execute('SELECT DISTINCT "专业" m FROM decision_points').fetchall()
    n = 0
    for r in rows:
        cat = S.major_category(r['m'])
        if cat != r['m']:
            n += c.execute('UPDATE decision_points SET "专业" = %s WHERE "专业" = %s', (cat, r['m'])).rowcount
    left = c.execute('SELECT count(DISTINCT "专业") FROM decision_points').fetchone()['count']
print(f'改了 {n} 个决策点，现在 {left} 种专业')
