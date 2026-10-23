import time
import json
import re
from .clients import ServiceError
from .situation import parse, clean_filters, normalize_major
from .storage import connection, recall, browse, count, DatabaseError


def fuse(vector_rows, text_rows, limit=30):
    by_id = {}
    for route, rows in [('vector', vector_rows), ('text', text_rows)]:
        for rank, row in enumerate(rows, 1):
            key = row['decision_point_id']
            item = by_id.setdefault(key, {**row, 'rrf_score': 0.0, 'vector_score': None, 'text_score': None,
                                          'vector_rank': None, 'text_rank': None, 'rerank_score': None})
            item['rrf_score'] += 1 / (60 + rank)
            item[route + '_rank'] = rank
            item[route + '_score'] = float(row[route + '_score'])
    return sorted(by_id.values(), key=lambda c: (-c['rrf_score'], c['decision_point_id']))[:limit]


def differences(candidate, parsed, filters):
    dp = candidate['decision_point']
    wanted = {**{k: v for k, v in parsed['situation'].items() if v},
              **{k: vals for k, vals in filters.items() if vals}}
    result = []
    for field, values in wanted.items():
        values = values if isinstance(values, list) else [values]
        if field == '路径':
            choices = [('考研', r'考研|二战|跨考|考非全'), ('保研', r'保研'), ('出国', r'出国|留学|PhD'),
                       ('考公', r'考公|国考|省考|选调'), ('工作', r'秋招|春招|求职|工作|算法|量化|研究所|offer|投行')]
            actual = next((path for path, pattern in choices if re.search(pattern, dp.get('最后的选择', ''))), '其他')
        else:
            actual = dp.get(field, '未提及')
        compare = normalize_major(actual) if field == '专业' else actual
        if compare not in values:
            result.append({'field': field, 'expected': values, 'actual': actual,
                           'unknown': actual in ('未提及', '', None)})
    return result


def run(query, models, filters=None, top_k=30, on_step=None, mode='hybrid_rerank'):
    if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 30:
        raise ValueError('top_k must be an integer between 1 and 30')
    if mode not in ('text', 'vector', 'hybrid', 'hybrid_rerank'):
        raise ValueError('unknown retrieval mode')
    start = time.perf_counter()
    steps = []

    def log(step, label, detail, since):
        item = {'step': step, 'label': label, 'detail': json.dumps(detail, ensure_ascii=False) if isinstance(detail, dict) else detail, 'ms': round((time.perf_counter() - since) * 1000)}
        steps.append(item)
        if on_step:
            on_step(item)

    parsed = parse(query, models)
    active = {**parsed['filters'], **(filters or {})}
    active = clean_filters(active)
    log('①', '处境抽取', {'source': parsed['source'], 'filters': active, 'irrelevant': parsed['irrelevant']}, start)
    degraded = list(parsed['degraded'])
    result = {'query': query, 'parsed': parsed, 'filters': active, 'status': 'irrelevant' if parsed['irrelevant'] else 'ok',
              'candidates': [], 'closest': [], 'relaxations': [], 'counts': None, 'steps': steps,
              'degraded': degraded, 'mode': mode, 'threshold_applied': False,
              'relevance_calibrated': models.config.threshold is not None, 'candidate_count': 0,
              'categories': ['保研', '考研', '出国', '求职', '考公', '选导师']}
    if parsed['irrelevant']:
        return {**result, 'api_calls': models.calls, 'elapsed_ms': round((time.perf_counter() - start) * 1000)}
    try:
        t = time.perf_counter()
        vector = None
        if query.strip() and mode != 'text':
            try:
                vector = models.embed([query])[0]
            except ServiceError:
                degraded.append('embedding_unavailable')
        with connection(models.config) as conn:
            if not query.strip():
                rows = browse(conn, models.config, active)
                candidates = [{**r, 'vector_score': None, 'text_score': None, 'rrf_score': None, 'rerank_score': None} for r in rows]
                vector_rows, text_rows = [], []
            else:
                vector_rows, text_rows = recall(conn, models.config, active, query, vector)
                if mode == 'vector':
                    text_rows = []
                candidates = fuse(vector_rows, text_rows)
            # Counts are over the active indexed corpus, NOT the limited candidates.
            result['counts'] = {'scope': 'current_index_matching_filters', **count(conn, models.config, active)}
            log('②', '混合召回', {'vector': len(vector_rows), 'text': len(text_rows), 'merged': len(candidates)}, t)
            t = time.perf_counter()
            reranked = False
            if candidates and query.strip() and mode == 'hybrid_rerank':
                try:
                    scores = models.rerank(query, [c['text'] for c in candidates])
                    for i, c in enumerate(candidates):
                        c['rerank_score'] = scores[i]
                    candidates.sort(key=lambda c: (-c['rerank_score'], c['decision_point_id']))
                    reranked = True
                except ServiceError:
                    degraded.append('reranker_unavailable')
            log('③', '重排', {'method': 'reranker' if reranked else ('browse' if not query.strip() else 'rrf'), 'count': len(candidates)}, t)
            if reranked and models.config.threshold is not None:
                result['threshold_applied'] = True
                accepted = [c for c in candidates if c['rerank_score'] >= models.config.threshold]
            else:
                accepted = candidates
            for rank, c in enumerate(accepted[:top_k], 1):
                result['candidates'].append({**c, 'rank': rank})
            if not accepted:
                result['status'] = 'service_error' if query.strip() and mode == 'vector' and vector is None else 'no_match'
                t = time.perf_counter()
                for field, values in active.items():
                    if values:
                        # Clearing an OR group broadens it; removing one OR value would narrow it.
                        relaxed = {**active, field: []}
                        result['relaxations'].append({'field': field, 'values': values, 'filters': relaxed,
                                                      'counts': count(conn, models.config, relaxed)})
                if query.strip():
                    near_vector, near_text = recall(conn, models.config, clean_filters({}), query, vector)
                    near = fuse(near_vector, near_text)
                else:
                    near = browse(conn, models.config, clean_filters({}))
                seen = set()
                for c in near:
                    if c['person_id'] in seen:
                        continue
                    seen.add(c['person_id'])
                    result['closest'].append({**c, 'label': '相近经历，不满足本次匹配条件',
                                              'differences': differences(c, parsed, active)})
                    if len(result['closest']) == 2:
                        break
                log('建议', '无结果建议', {'relaxations': len(result['relaxations']), 'closest': len(result['closest'])}, t)
    except DatabaseError:
        result.update(status='service_error', error={'code': 'database_unavailable', 'message': '数据库不可用或尚未执行 RAG 建表脚本'},
                      candidates=[], closest=[], relaxations=[], counts=None)
    result.update(api_calls=models.calls, elapsed_ms=round((time.perf_counter() - start) * 1000),
                  candidate_count=len(result['candidates']), degraded=list(dict.fromkeys(degraded)))
    return result
