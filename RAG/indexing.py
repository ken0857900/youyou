from dataclasses import dataclass, field
import hashlib
import time
from .storage import (connection, fetchall, load_article, check_quotes, strip_images, digest,
                      snapshot_hash, StaleIndexError)
from .clients import ServiceError


@dataclass
class PreparedIndex:
    article_id: str
    snapshot: str
    chunks: list[dict]
    article: dict = field(repr=False)
    points: list[dict] = field(repr=False)


def build_chunks(article, points, config):
    if len({p['id'] for p in points}) != len(points):
        raise ValueError('decision point ids must be unique')
    result = []
    if article['type'] != 'article' or article['status'] != 'published':
        return result
    for point in points:
        if str(point.get('article_id', article['id'])) != str(article['id']):
            raise ValueError('decision point belongs to another article')
        quote = point.get('原话', '')
        evidence = quote if quote != '未提及' and check_quotes(article['content'], [quote])[0]['valid'] else ''
        # Removing image syntax must not manufacture a contiguous quote absent from the source.
        if evidence and strip_images(evidence) != evidence:
            evidence = ''
        # Do not embed arbitrary whole articles: a chunk represents one decision only.
        fields = {k: point.get(k, '未提及') for k in ('决策类型', '学校层级', '专业', '成绩', '年级', '考虑过的选项', '最后的选择', '结果', '结果说明', '年份')}
        text = strip_images(article['title'] + '\n' + '\n'.join(f'{k}: {v}' for k, v in fields.items()) + '\n' + evidence).strip()
        # BGE-M3 input capped conservatively to avoid silently truncating vectors at provider.
        if len(text) > 6000:
            raise ValueError('decision chunk exceeds 6000 characters; shorten the decision evidence')
        result.append({'decision_point_id': point['id'], 'text': text, 'evidence': strip_images(evidence),
                       'content_hash': digest(text), 'article_hash': hashlib.md5(article['content'].encode()).hexdigest(),
                       'embedding_model': config.embedding_model, 'chunk_version': config.chunk_version})
    return result


def prepare(article, points, models, existing=(), force=False):
    chunks = build_chunks(article, points, models.config)
    cached = {(row['content_hash'], row['embedding_model'], row['chunk_version']): row['embedding'] for row in existing}
    pending = [c for c in chunks if force or (c['content_hash'], c['embedding_model'], c['chunk_version']) not in cached]
    vectors = models.embed([c['text'] for c in pending]) if pending else []
    if len(vectors) != len(pending):
        raise ServiceError('embedding count mismatch')
    for chunk, vector in zip(pending, vectors):
        chunk['embedding'] = vector
    for chunk in chunks:
        if 'embedding' not in chunk:
            chunk['embedding'] = cached[(chunk['content_hash'], chunk['embedding_model'], chunk['chunk_version'])]
    return PreparedIndex(article['id'], snapshot_hash(article, points), chunks, dict(article), [dict(p) for p in points])


def vector_text(vector):
    return vector if isinstance(vector, str) else '[' + ','.join(str(float(x)) for x in vector) + ']'


def write_prepared(prepared, conn, config):
    """Atomic savepoint; caller owns the surrounding transaction and commit."""
    from psycopg.pq import TransactionStatus
    if conn.info.transaction_status == TransactionStatus.IDLE:
        raise ValueError('save_index requires an active caller transaction: use with connection.transaction()')
    with conn.transaction():
        article, points = load_article(conn, prepared.article_id, lock=True)
        if snapshot_hash(article, points) != prepared.snapshot:
            raise StaleIndexError('article or decision points changed; prepare again')
        conn.execute('DELETE FROM chunks WHERE article_id=%s AND embedding_model=%s AND chunk_version=%s',
                     (prepared.article_id, config.embedding_model, config.chunk_version))
        for chunk in prepared.chunks:
            conn.execute('''INSERT INTO chunks (article_id, decision_point_id, text, evidence, embedding, tsv,
                            content_hash, article_hash, embedding_model, chunk_version)
                            VALUES (%s,%s,%s,%s,%s::vector,to_tsvector('chinese',%s),%s,%s,%s,%s)''',
                         (prepared.article_id, chunk['decision_point_id'], chunk['text'], chunk['evidence'],
                          vector_text(chunk['embedding']), chunk['text'], chunk['content_hash'], chunk['article_hash'],
                          chunk['embedding_model'], chunk['chunk_version']))
    return {'article_id': prepared.article_id, 'chunks': len(prepared.chunks)}


def index(article_id, models, existing_connection=None, force=False):
    started = time.perf_counter()
    calls_before = models.calls
    # A passed-in connection may contain uncommitted article/point writes; never commit it.
    with connection(models.config, existing_connection) as conn:
        article, points = load_article(conn, article_id)
        old = fetchall(conn, 'SELECT content_hash, embedding_model, chunk_version, embedding::text FROM chunks WHERE article_id=%s', (article_id,))
    loaded = time.perf_counter()
    prepared = prepare(article, points, models, old, force)
    prepared_at = time.perf_counter()
    with connection(models.config, existing_connection) as conn:
        if existing_connection is None:
            with conn.transaction():
                result = write_prepared(prepared, conn, models.config)
        else:
            result = write_prepared(prepared, conn, models.config)
    finished = time.perf_counter()
    return {**result, 'api_calls': models.calls - calls_before, 'timings_ms': {
        'load_and_cache': round((loaded-started)*1000),
        'text_processing_and_embedding': round((prepared_at-loaded)*1000),
        'transactional_index_write': round((finished-prepared_at)*1000),
        'total': round((finished-started)*1000)}}
