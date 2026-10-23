import argparse
import json
from pathlib import Path
from . import search, index_article
from .config import Config
from .clients import Models
from .indexing import index
from .storage import connection, fetchall


def main():
    parser = argparse.ArgumentParser(description='PathFinder RAG tools (run from repository root)')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('migrate', help='add chunks table; never initializes the main application schema')
    p = sub.add_parser('index')
    p.add_argument('article_id')
    p = sub.add_parser('rebuild')
    p.add_argument('--force', action='store_true', help='re-embed even unchanged chunks')
    sub.add_parser('refresh-fts', help='refresh Chinese tsv only; no model calls')
    p = sub.add_parser('search')
    p.add_argument('query')
    p.add_argument('--filters', default='{}', help='JSON filter overrides')
    p = sub.add_parser('seed-dev', help='insert clearly labeled development corpus, idempotently; never resets tables')
    args = parser.parse_args()
    config = Config.load()
    if args.command == 'search':
        print(json.dumps(search(args.query, json.loads(args.filters)), ensure_ascii=False, indent=2, default=str))
        return
    if args.command == 'index':
        print(json.dumps(index_article(args.article_id), ensure_ascii=False))
        return
    if args.command in ('migrate', 'refresh-fts', 'seed-dev'):
        with connection(config) as conn:
            if args.command == 'migrate':
                conn.execute((Path(__file__).parent / 'schema.sql').read_text())
            elif args.command == 'refresh-fts':
                conn.execute("UPDATE chunks SET tsv=to_tsvector('chinese',text), updated_at=now()")
            else:
                seed(conn)
        print(json.dumps({'ok': True, 'command': args.command}))
        return
    with connection(config) as conn:
        articles = fetchall(conn, "SELECT id FROM articles WHERE type='article' ORDER BY id")
    for article in articles:
        print(json.dumps(index(article['id'], Models(config), force=args.force), ensure_ascii=False))


def seed(conn):
    """Only adds ragdev_* rows, never touches existing website seed records."""
    data = json.loads((Path(__file__).parent / 'data' / 'corpus.json').read_text())
    for article in data['articles']:
        pid, aid = article['author_id'], article['id']
        conn.execute('INSERT INTO persons(id,name,school_tier,major) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                     (pid, '[开发样本] ' + pid, article['decision_points'][0]['学校层级'], article['decision_points'][0]['专业']))
        conn.execute('''INSERT INTO articles(id,author_id,type,status,category,title,content) VALUES (%s,%s,'article','published',%s,%s,%s)
                        ON CONFLICT DO NOTHING''', (aid, pid, article['decision_points'][0]['决策类型'], article['title'], article['content']))
        if fetchall(conn, 'SELECT id FROM decision_points WHERE article_id=%s', (aid,)):
            continue
        for point in article['decision_points']:
            fields = list(point)
            # Field names are controlled by the checked-in fixture, never user input.
            from .storage import DP_FIELDS
            if set(fields) - set(DP_FIELDS):
                raise ValueError('unknown fixture field')
            cols = ','.join('"' + f + '"' for f in fields)
            conn.execute(f'INSERT INTO decision_points(article_id,{cols}) VALUES (%s,{",".join(["%s"] * len(fields))})',
                         [aid, *[point[f] for f in fields]])


if __name__ == '__main__':
    main()
