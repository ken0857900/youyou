"""Real isolated end-to-end acceptance: python -m RAG.smoke --output RAG/reports/live.json.

Creates/deletes only a random ragtest_* schema. Real model requests incur small fees.
Never initializes or truncates the application tables.
"""
import argparse
import json
import time
import uuid
from dataclasses import replace
from pathlib import Path
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from .config import Config
from .clients import Models, ServiceError
from .storage import DatabaseError, connection, fetchall
from .indexing import index
from .retrieval import run
from .__main__ import seed

ROOT = Path(__file__).parent


def execute(config, output, keep_data=False, all_articles=False):
    report = {'status': 'running', 'synthetic_corpus': True,
              'query': '双非计算机保研失败转考研', 'stages': [], 'results': [],
              'application_tables_modified': False}
    begin = time.perf_counter()
    def stage(name, fn):
        start = time.perf_counter()
        item = {'stage': name}
        try:
            value = fn()
            item.update(status='passed', detail=value)
            return value
        except Exception as error:
            # Raw exceptions can include DSNs, credentials, URLs or provider bodies.
            item.update(status='failed', error_type=type(error).__name__)
            raise
        finally:
            item['ms'] = round((time.perf_counter()-start)*1000)
            report['stages'].append(item)

    schema = 'ragtest_' + uuid.uuid4().hex
    admin = None
    created = False
    models = Models(config)
    try:
        report['key_configured'] = bool(config.api_key)
        def connect_database():
            nonlocal admin
            try:
                admin = psycopg.connect(config.database_url, autocommit=True, row_factory=dict_row, connect_timeout=3)
            except psycopg.Error:
                raise DatabaseError('database connection unavailable') from None
            return {'connected': True}
        stage('database_connection', connect_database)
        def inventory():
            exists = admin.execute("SELECT to_regclass('public.articles') AS table_name").fetchone()['table_name']
            if exists is None:
                return {'public_articles_table_exists': False, 'public_articles': 0}
            return {'public_articles_table_exists': True, 'public_articles': admin.execute('SELECT count(*) AS n FROM public.articles').fetchone()['n']}
        report['existing_data'] = stage('existing_application_articles', inventory)
        def extensions():
            rows = admin.execute("SELECT extname,extversion FROM pg_extension WHERE extname IN ('vector','zhparser') ORDER BY extname").fetchall()
            if {r['extname'] for r in rows} != {'vector','zhparser'}:
                raise RuntimeError('required extensions unavailable')
            tokens = admin.execute("SELECT to_tsvector('chinese','双非计算机保研失败转考研')::text AS tokens").fetchone()['tokens']
            if not tokens:
                raise RuntimeError('Chinese tokenization returned no lexemes')
            return {'extensions': rows, 'chinese_tokens': tokens}
        stage('extensions_and_chinese_tokenizer', extensions)
        if not config.api_key:
            report.update(status='blocked', reason='siliconflow_key_not_configured')
            return report
        def initialize():
            nonlocal created
            admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
            created = True
            admin.execute(sql.SQL('SET search_path TO {}, public').format(sql.Identifier(schema)))
            admin.execute((ROOT/'tests/fixture_schema.sql').read_text())
            admin.execute((ROOT/'schema.sql').read_text())
            seed(admin)
            return {'fixture_articles': 30, 'fixture_decision_points': 31, 'isolated_schema': schema}
        stage('isolated_fixture_setup', initialize)
        test_config = replace(config, database_url=make_conninfo(config.database_url, options=f'-c search_path={schema},public'),
                              llm_key='', threshold=None)
        models = Models(test_config)
        def build():
            outputs=[]
            article_ids = [r['id'] for r in admin.execute('SELECT id FROM articles ORDER BY id').fetchall()] if all_articles else ['ragdev_a01','ragdev_a02','ragdev_a13']
            for aid in article_ids:
                outputs.append(index(aid, models))
            return {'indexed_articles':len(outputs), 'chunks':sum(o['chunks'] for o in outputs), 'api_calls':models.calls, 'articles': outputs}
        stage('text_embedding_and_pgvector_write', build)
        stage('incremental_unchanged_skip', lambda: unchanged(models))
        stage('incremental_update', lambda: update(models))
        def search_once():
            out = run(report['query'], models)
            report['retrieval_steps'] = out['steps']
            report['results'] = [{k:c.get(k) for k in ('article_id','decision_point_id','person_id','title','evidence','rank','vector_score','text_score','rrf_score','rerank_score')}
                                 for c in out['candidates']]
            report['degraded'] = out['degraded']
            stages={s['step']:json.loads(s['detail']) for s in out['steps'] if s['step'] in ('②','③')}
            if out['status']!='ok' or not out['candidates']:
                raise RuntimeError('search did not return candidates')
            if not any(c['article_id']=='ragdev_a13' for c in out['candidates']):
                raise RuntimeError('expected relevant article not retrieved')
            if not stages['②']['vector'] or not stages['②']['text'] or stages['③']['method']!='reranker':
                raise RuntimeError('one or more real retrieval routes did not run')
            return {'returned':len(out['candidates']), 'expected_article_found':True, 'routes':stages}
        stage('real_hybrid_search_and_rerank', search_once)
        report['status']='passed'
    except (DatabaseError, psycopg.Error):
        report.update(status='blocked', reason='database_or_extensions_unavailable')
    except ServiceError:
        report.update(status='failed', reason='model_service_failed')
    except Exception as error:
        report.update(status='failed', reason='acceptance_assertion_or_setup_failed', error_type=type(error).__name__)
    finally:
        if admin is not None:
            if created and keep_data and report['status']=='passed':
                report['cleanup']='retained_for_development'
                report['test_schema']=schema
            elif created:
                try:
                    admin.execute('SET search_path TO public')
                    admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
                    report['cleanup']='passed'
                except psycopg.Error:
                    report['cleanup']='failed'
                    report['status']='failed'
            admin.close()
        report['api_calls']=models.calls
        report['elapsed_ms']=round((time.perf_counter()-begin)*1000)
        output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str)+'\n')
    return report


def unchanged(models):
    before=models.calls
    out=index('ragdev_a13',models)
    if models.calls!=before:
        raise RuntimeError('unchanged article unexpectedly re-embedded')
    return {'chunks':out['chunks'], 'embedding_api_calls':models.calls-before}


def update(models):
    before=models.calls
    with connection(models.config) as conn:
        conn.execute('UPDATE decision_points SET "成绩"=%s WHERE article_id=%s AND "决策类型"=%s', ('GPA 3.8','ragdev_a13','考研'))
        conn.execute('UPDATE articles SET content=content||%s WHERE id=%s', ('\n[开发样本更新测试]','ragdev_a13'))
        out=index('ragdev_a13',models,conn)
        rows=fetchall(conn,'SELECT text FROM chunks WHERE article_id=%s',('ragdev_a13',))
        if not any('GPA 3.8' in r['text'] for r in rows) or len(rows)!=2 or models.calls==before:
            raise RuntimeError('incremental update was not persisted')
    return {'chunks':out['chunks'], 'embedding_api_calls':models.calls-before}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'reports/live.json')
    parser.add_argument('--keep-data',action='store_true',help='retain the isolated schema after successful acceptance for repeatable development searches')
    parser.add_argument('--all-articles',action='store_true',help='index all 30 synthetic articles instead of the minimal 3')
    args=parser.parse_args()
    report=execute(Config.load(),args.output,keep_data=args.keep_data,all_articles=args.all_articles)
    print(json.dumps(report,ensure_ascii=False,indent=2,default=str))
    raise SystemExit(0 if report['status']=='passed' else 2)


if __name__=='__main__':
    main()
