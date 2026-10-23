"""Synthetic retrieval evaluation and adapters for Ken's agent/long-context runs."""
import argparse
import json
import statistics
from pathlib import Path
from .config import Config
from .clients import Models
from .retrieval import run
from .storage import connection, fetchall

DATA = Path(__file__).parent / 'data'
MODES = ('text', 'vector', 'hybrid', 'hybrid_rerank')


def metrics(cases, predictions):
    by_id = {p['id']: p for p in predictions}
    d_hits, d_rr, p_hits, p_rr, attack, latencies, calls = [], [], [], [], [], [], []
    failures = []
    for case in cases:
        pred = by_id.get(case['id'])
        if pred is None:
            failures.append({'id': case['id'], 'reason': 'missing_prediction'})
            pred = {'id': case['id'], 'status': 'missing_prediction', 'candidates': []}
        if pred.get('status') == 'service_error':
            failures.append({'id': case['id'], 'reason': 'service_error'})
        gold = {(r['article_id'], r['point_ordinal']) for r in case['relevant']}
        if gold:
            ranks = [i for i, r in enumerate(pred.get('candidates', []), 1) if (r['article_id'], r.get('point_ordinal')) in gold]
            d_hits.append(int(bool(ranks) and ranks[0] <= 5))
            d_rr.append(1 / ranks[0] if ranks else 0)
            people = list(dict.fromkeys(r['person_id'] for r in pred.get('candidates', [])))
            pranks = [i for i, p in enumerate(people, 1) if p in case['relevant_person_ids']]
            p_hits.append(int(bool(pranks) and pranks[0] <= 5))
            p_rr.append(1 / pranks[0] if pranks else 0)
        if case['adversarial']:
            passed = pred.get('status') == case['expected_status']
            if case['id'] == 'q29':
                passed = passed and not pred.get('filters', {}).get('结果')
            if case['id'] == 'q30':
                passed = passed and pred.get('filters', {}).get('年份') == ['2026']
            attack.append(int(passed))
        latencies.append(pred.get('elapsed_ms', 0))
        calls.append(pred.get('api_calls', 0))
    mean = lambda xs: statistics.mean(xs) if xs else None
    return {'decision_hit_at_5': mean(d_hits), 'decision_mrr': mean(d_rr), 'person_hit_at_5': mean(p_hits),
            'person_mrr': mean(p_rr), 'adversarial_pass_rate': mean(attack),
            'latency_mean_ms': mean(latencies), 'latency_p95_ms': sorted(latencies)[max(0, int(len(latencies)*.95+.999)-1)] if latencies else None,
            'api_calls': sum(calls), 'cases': len(cases), 'predictions': len(predictions), 'failures': failures}


def calibrate(cases, predictions, config):
    """Choose candidate-level F1 threshold on validation only; never use test labels."""
    labels = {c['id']: c for c in cases if c['split'] == 'validation'}
    pairs = []
    for pred in predictions:
        case = labels.get(pred['id'])
        if case is None or case['expected_status'] not in ('ok', 'no_match') or not case['query'].strip():
            continue
        gold = {(r['article_id'], r['point_ordinal']) for r in case['relevant']}
        for c in pred.get('candidates', []):
            if c.get('rerank_score') is not None:
                pairs.append((c['rerank_score'], int((c['article_id'], c.get('point_ordinal')) in gold)))
    if not pairs or not {label for _, label in pairs} == {0, 1}:
        raise ValueError('calibration needs scored positive AND negative validation candidates')
    choices = sorted({score for score, _ in pairs})
    scored = []
    for threshold in choices:
        tp = sum(score >= threshold and label for score, label in pairs)
        fp = sum(score >= threshold and not label for score, label in pairs)
        fn = sum(score < threshold and label for score, label in pairs)
        f1 = 2*tp / (2*tp+fp+fn) if tp else 0
        scored.append((f1, threshold))
    f1, threshold = max(scored)
    return {'threshold': threshold, 'validation_candidate_f1': f1, 'embedding_model': config.embedding_model,
            'rerank_model': config.rerank_model, 'chunk_version': config.chunk_version,
            'source': 'synthetic_validation', 'warning': '开发样本门槛，真实文章需重新校准；分数不是概率'}


def ordinal_map(config):
    with connection(config) as conn:
        rows = fetchall(conn, 'SELECT id, article_id, row_number() OVER (PARTITION BY article_id ORDER BY id)-1 AS ordinal FROM decision_points')
    return {r['id']: r['ordinal'] for r in rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=(*MODES, 'all'), default='all')
    parser.add_argument('--queries', type=Path, default=DATA/'queries.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--predictions', type=Path, help='external JSON list: id,status,candidates,elapsed_ms,api_calls')
    parser.add_argument('--export-context', type=Path, help='export corpus + questions for agent or long-context baseline, no API calls')
    parser.add_argument('--calibrate', type=Path, help='save threshold JSON from validation; only hybrid_rerank mode')
    args = parser.parse_args()
    cases = json.loads(args.queries.read_text())['cases']
    config = Config.load()
    if args.export_context:
        # Export actual indexed application content, not assumptions about local fixture IDs.
        with connection(config) as conn:
            articles = fetchall(conn, "SELECT id,author_id,title,content FROM articles WHERE type='article' AND status='published' ORDER BY id")
            points = fetchall(conn, 'SELECT * FROM decision_points ORDER BY article_id,id')
        args.export_context.write_text(json.dumps({'articles': articles, 'decision_points': points, 'cases': cases,
                                                   'prediction_format': 'list of {id,status,candidates:[{article_id,point_ordinal,person_id}],elapsed_ms,api_calls}'},
                                                  ensure_ascii=False, indent=2, default=str))
        args.output.write_text(json.dumps({'exported': str(args.export_context), 'cases': len(cases)}, indent=2))
        return
    if args.predictions:
        preds = json.loads(args.predictions.read_text())
        report = {'external': metrics(cases, preds)}
    else:
        if args.calibrate and args.mode != 'hybrid_rerank':
            parser.error('--calibrate requires --mode hybrid_rerank')
        ordinals = ordinal_map(config)
        report = {}
        for mode in MODES if args.mode == 'all' else [args.mode]:
            if args.calibrate:
                config.threshold = None
            predictions = []
            for case in cases:
                try:
                    out = run(case['query'], Models(config), mode=mode)
                except ValueError:
                    out = {'status': 'invalid_input', 'candidates': []}
                for c in out['candidates']:
                    c['point_ordinal'] = ordinals.get(c['decision_point_id'])
                predictions.append({'id': case['id'], **out})
            if args.calibrate:
                calibration = calibrate(cases, predictions, config)
                args.calibrate.write_text(json.dumps(calibration, ensure_ascii=False, indent=2))
                # Re-score saved predictions without a second paid model run.
                for p in predictions:
                    if p.get('threshold_applied') is False and p['status'] in ('ok', 'no_match') and p.get('query', '').strip() and 'reranker_unavailable' not in p.get('degraded', []):
                        p['candidates'] = [c for c in p['candidates'] if c.get('rerank_score') is not None and c['rerank_score'] >= calibration['threshold']]
                        p['status'] = 'ok' if p['candidates'] else 'no_match'
            report[mode] = {'all': metrics(cases, predictions),
                            'held_out_test': metrics([c for c in cases if c['split'] == 'test'], [p for p in predictions if any(c['id']==p['id'] and c['split']=='test' for c in cases)]),
                            'predictions': predictions}
    args.output.write_text(json.dumps({'synthetic': True, 'notice': '开发样本结果不代表真实文章效果', 'results': report}, ensure_ascii=False, indent=2, default=str))


if __name__ == '__main__':
    main()
