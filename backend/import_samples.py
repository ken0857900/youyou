"""把 AI 生成的示例人物＋文章灌进数据库（10/20 决定：参赛版文章用 AI 生成，网站上标「示例」）。
文章不带决策点：每篇照网站真实流程交给大模型抽（07 #1），再建 RAG 索引——跟分享者发文走同一条路。
已经在库里的同 id 人物／同标题文章会跳过，可以重复跑。

用法（仓库根目录）：backend/.venv/Scripts/python backend/import_samples.py 示例.json
文件格式：{"persons": [{"id", "name", "schoolTier", "major", "title", "tagline", "school", "gradYear", "timeline"?: [{"year", "title", "desc"}]}, ...],
           "articles": [{"author", "type": "article"|"diary", "title", "content", "date"}, ...]}"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).parent))
from app import agents as A, freshness as F, llm  # noqa: E402
from app.db import connect, one  # noqa: E402
from app.main import letter_avatar  # noqa: E402

PREFIX = 'ai_'  # 示例人物 id 前缀，跟真人（u{账号id}）、旧种子（p1…）分开


def extract(a, person):
    if a.get('type', 'article') != 'article':
        return []
    try:
        author = {'学校层级': person.get('schoolTier'), '专业': person.get('major')}  # 人物还没入库，直接用 JSON 里作者填的本科出身
        return A.extract_decision_points(a['title'], a['content'], author) or [A.DecisionPoint().model_dump()]
    except (llm.LLMUnavailable, ValueError) as e:
        print(f"  ⚠️ 抽取失败，放占位：{a['title'][:20]}（{e}）")
        return [A.DecisionPoint().model_dump()]


def main(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    persons, articles = data.get('persons', []), data.get('articles', [])
    ids = {p['id']: PREFIX + p['id'] for p in persons}
    by_id = {p['id']: p for p in persons}
    bad = [a['title'] for a in articles if a.get('author') not in ids]
    if bad:
        sys.exit(f'这些文章的 author 不在 persons 里：{bad[:5]}')
    todo = [a for a in articles if not one('SELECT 1 FROM articles WHERE title = %s', (a['title'],))]
    print(f'{len(persons)} 位人物，{len(articles)} 篇文章（{len(articles) - len(todo)} 篇已在库里，跳过）')

    # ponytail: 8 篇并行抽，DeepSeek 限流了再调小
    with ThreadPoolExecutor(max_workers=8) as pool:
        points = list(pool.map(extract, todo, [by_id[a['author']] for a in todo]))

    new = []
    with connect() as c:
        for p in persons:
            profile = {k: p.get(k, '') for k in ('title', 'tagline', 'school', 'gradYear', 'city')}
            profile.update(avatar=letter_avatar(p['name']), tags=p.get('tags', []), timeline=p.get('timeline', []), faqs=[], sample=True)
            c.execute('INSERT INTO persons (id, name, school_tier, major, profile) VALUES (%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING',
                      (ids[p['id']], p['name'], p.get('schoolTier'), p.get('major'), Jsonb(profile)))
        for a, pts in zip(todo, points):
            plain = A.strip_images(a['content'])
            category = pts[0]['决策类型'] if pts and pts[0]['决策类型'] != A.NA else a.get('category', '未提及')
            aid = c.execute('INSERT INTO articles (author_id, type, category, title, summary, content, tags, date) '
                            'VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id',
                            (ids[a['author']], a.get('type', 'article'), category, a['title'],
                             plain[:60] + ('…' if len(plain) > 60 else ''), a['content'], ['示例'], a.get('date') or 'today')).fetchone()['id']
            if pts:
                A.save_points(c, aid, pts)
                A.rag_index(c, aid)
            new.append(aid)
            print(f"  ✓ {aid} {category} · {a['title'][:30]}（{len(pts)} 个决策点）")
    # 流程 D 保鲜度：提到光华的文章抽主张、对最新通知判断（先跑过 python -m app.freshness crawl 才有规则）
    with ThreadPoolExecutor(max_workers=8) as pool:
        n = sum(pool.map(F.index_article, new))
    print(f'保鲜度：{n} 句光华招生规则')
    print('完成')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
