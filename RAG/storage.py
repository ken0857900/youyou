import hashlib
import json
import re
from contextlib import contextmanager
import psycopg
from psycopg.rows import dict_row
from .situation import clean_filters

DP_FIELDS = ('决策类型', '学校层级', '专业', '成绩', '年级', '考虑过的选项', '最后的选择', '结果', '结果说明', '年份', '原话')
PATH_SQL = """CASE WHEN d."最后的选择" ~ '考研|二战|跨考|考非全' THEN '考研'
 WHEN d."最后的选择" ~ '保研' THEN '保研'
 WHEN d."最后的选择" ~ '出国|留学|PhD' THEN '出国'
 WHEN d."最后的选择" ~ '考公|国考|省考|选调' THEN '考公'
 WHEN d."最后的选择" ~ '秋招|春招|求职|工作|算法|量化|研究所|offer|投行' THEN '工作' ELSE '其他' END"""


class DatabaseError(RuntimeError):
    pass


class StaleIndexError(RuntimeError):
    pass


def strip_images(text):
    return re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text or '')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def snapshot_hash(article, points):
    return digest({'title': article['title'], 'content': article['content'], 'type': article['type'],
                   'status': article['status'], 'points': [{k: p.get(k) for k in ('id', *DP_FIELDS)} for p in points]})


def normalized_with_offsets(text):
    indexes = [i for i, c in enumerate(text) if not c.isspace()]
    return ''.join(text[i] for i in indexes), indexes


def check_quotes(text, quotes):
    normalized, offsets = normalized_with_offsets(text)
    results = []
    for quote in quotes:
        if not isinstance(quote, str):
            results.append({'quote': quote, 'valid': False, 'reason': 'not_text', 'start': None, 'end': None})
            continue
        needle = ''.join(quote.split())
        pos = normalized.find(needle) if needle else -1
        valid = pos >= 0
        results.append({'quote': quote, 'valid': valid, 'reason': None if valid else ('empty' if not needle else 'not_in_article'),
                        'start': offsets[pos] if valid else None,
                        'end': offsets[pos + len(needle) - 1] + 1 if valid else None})
    return results


@contextmanager
def connection(config, existing=None):
    try:
        if existing is not None:
            yield existing
        else:
            with psycopg.connect(config.database_url, row_factory=dict_row, connect_timeout=3) as conn:
                yield conn
    except psycopg.Error:
        raise DatabaseError('RAG database operation failed; check connection and migration') from None


def fetchall(conn, sql, params=None):
    # Use our own cursor to support caller connections with tuple row factories.
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()


def fetchone(conn, sql, params=None):
    rows = fetchall(conn, sql, params)
    return rows[0] if rows else None


def load_article(conn, article_id, lock=False):
    article = fetchone(conn, 'SELECT * FROM articles WHERE id=%s' + (' FOR UPDATE' if lock else ''), (article_id,))
    if not article:
        raise ValueError('article not found')
    points = fetchall(conn, 'SELECT * FROM decision_points WHERE article_id=%s ORDER BY id' + (' FOR UPDATE' if lock else ''), (article_id,))
    return article, points


def where_filters(filters):
    filters = clean_filters(filters)
    clauses, params = [], []
    for field, values in filters.items():
        if values:
            if field == '路径':
                expr = PATH_SQL
            elif field == '专业':
                expr = '''CASE WHEN d."专业" IN ('计算机科学与技术','计算机科学','软件工程','CS') THEN '计算机' ELSE d."专业" END'''
            else:
                expr = 'd."' + field + '"'
            clauses.append('(' + expr + ' = ANY(%s))')
            params.append(values)
    return (' AND ' + ' AND '.join(clauses) if clauses else ''), params


BASE_FROM = ' FROM chunks c JOIN decision_points d ON d.id=c.decision_point_id JOIN articles a ON a.id=c.article_id AND a.id=d.article_id '
# Ignore stale vectors after an article edit, even before explicit reindexing.
BASE_WHERE = " WHERE a.status='published' AND a.type='article' AND c.embedding_model=%s AND c.chunk_version=%s AND c.article_hash=md5(a.content) "
SELECT = '''SELECT c.id AS chunk_id, c.decision_point_id, c.article_id, a.author_id AS person_id,
 a.title, c.text, c.evidence, to_jsonb(d) - 'confidence' - 'updated_at' AS decision_point'''


def recall(conn, config, filters, query, vector=None):
    extra, params = where_filters(filters)
    common = [config.embedding_model, config.chunk_version, *params]
    vector_rows = []
    if vector is not None:
        vec = '[' + ','.join(str(float(x)) for x in vector) + ']'
        # Exact distance over a materialized filtered subset guarantees selective filters
        # do not underfill recall through HNSW post-filtering. Suitable for the contest corpus.
        vector_rows = fetchall(conn, 'WITH filtered AS MATERIALIZED (' + SELECT + ', c.embedding' + BASE_FROM + BASE_WHERE + extra +
                               ') SELECT chunk_id, decision_point_id, article_id, person_id, title, text, evidence, decision_point,'
                               ' 1 - (embedding <=> %s::vector) AS vector_score FROM filtered'
                               ' ORDER BY embedding <=> %s::vector, decision_point_id LIMIT 30', [*common, vec, vec])
    # Tokenize safely, then OR lexemes: long natural queries must not require every word.
    text_query = "to_tsquery('simple', replace(plainto_tsquery('chinese', %s)::text, ' & ', ' | '))"
    text_rows = fetchall(conn, SELECT + ", ts_rank_cd(c.tsv, " + text_query + ") AS text_score" + BASE_FROM + BASE_WHERE + extra +
                         " AND c.tsv @@ " + text_query + " ORDER BY text_score DESC, c.decision_point_id LIMIT 30",
                         [query, *common, query]) if query.strip() else []
    return vector_rows, text_rows


def browse(conn, config, filters, limit=30):
    extra, params = where_filters(filters)
    return fetchall(conn, SELECT + BASE_FROM + BASE_WHERE + extra + ' ORDER BY a.date DESC, c.decision_point_id LIMIT %s',
                    [config.embedding_model, config.chunk_version, *params, limit])


def count(conn, config, filters):
    extra, params = where_filters(filters)
    row = fetchone(conn, 'SELECT count(DISTINCT a.id) AS articles, count(DISTINCT a.author_id) AS persons, count(*) AS decision_points' +
                   BASE_FROM + BASE_WHERE + extra, [config.embedding_model, config.chunk_version, *params])
    return row
