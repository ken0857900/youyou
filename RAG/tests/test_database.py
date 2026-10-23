"""Opt in with RAG_TEST_DATABASE_URL. Every test uses a disposable random schema."""
import os
import uuid
from pathlib import Path
import pytest
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from RAG import indexing, storage
from RAG.config import Config
from RAG.clients import Models
from RAG.__main__ import seed


@pytest.fixture
def db():
    url=os.getenv('RAG_TEST_DATABASE_URL')
    if not url:
        pytest.skip('RAG_TEST_DATABASE_URL not set; requires PostgreSQL + pgvector + zhparser')
    schema='ragtest_'+uuid.uuid4().hex
    with psycopg.connect(url, autocommit=True, row_factory=dict_row) as conn:
        conn.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
        try:
            conn.execute(sql.SQL('SET search_path TO {}, public').format(sql.Identifier(schema)))
            assert conn.execute("SELECT to_regtype('vector') AS v").fetchone()['v'], 'pgvector is required'
            assert conn.execute("SELECT 'chinese'::regconfig AS c").fetchone()['c'], 'chinese configuration is required'
            conn.execute('''CREATE TABLE persons(id text PRIMARY KEY,name text,school_tier text,major text);
                CREATE TABLE articles(id text PRIMARY KEY,author_id text REFERENCES persons(id),type text,status text,
                  category text,title text,content text,date date DEFAULT current_date,
                  content_hash text GENERATED ALWAYS AS (md5(content)) STORED);''')
            cols=','.join('"'+f+'" '+ ('text[] DEFAULT \'{}\'' if f=='考虑过的选项' else "text DEFAULT '未提及'") for f in storage.DP_FIELDS)
            conn.execute('CREATE TABLE decision_points(id serial PRIMARY KEY, article_id text REFERENCES articles(id) ON DELETE CASCADE,'+cols+')')
            conn.execute((Path(__file__).parents[1]/'schema.sql').read_text())
            seed(conn)
            cfg=Config(url,'','', 'BAAI/bge-m3','BAAI/bge-reranker-v2-m3','','','',1,None)
            class Fake:
                config=cfg
                calls=0
                def embed(self,texts):
                    self.calls+=1
                    return [[1.0]+[0.0]*1023 for _ in texts]
            with conn.transaction():
                yield conn, Fake()
        finally:
            conn.execute('SET search_path TO public')
            conn.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


def test_index_sql_recall_and_delete(db):
    conn, models=db
    out=indexing.index('ragdev_a13',models,conn)
    assert out['chunks']==2 and models.calls==1
    indexing.index('ragdev_a13',models,conn)
    assert models.calls==1
    vectors,texts=storage.recall(conn,models.config,{'学校层级':['双非'],'决策类型':['考研','保研']},'考研',[1.0]+[0.0]*1023)
    assert len(vectors)==2 and texts
    assert len({r['decision_point_id'] for r in vectors})==2
    assert storage.count(conn,models.config,{})=={'articles':1,'persons':1,'decision_points':2}
    conn.execute("UPDATE articles SET content=content||'修改' WHERE id='ragdev_a13'")
    assert storage.count(conn,models.config,{})['decision_points']==0
    indexing.index('ragdev_a13',models,conn)
    assert storage.count(conn,models.config,{})['decision_points']==2
    conn.execute("DELETE FROM articles WHERE id='ragdev_a13'")
    assert conn.execute('SELECT count(*) AS n FROM chunks').fetchone()['n']==0


def test_failed_insert_rolls_back_and_caller_controls_transaction(db):
    conn, models=db
    indexing.index('ragdev_a13',models,conn)
    article,points=storage.load_article(conn,'ragdev_a13')
    p=indexing.prepare(article,points,models)
    p.chunks[1]['embedding']=[1.0,2.0]  # server rejects dimensions after delete + first insert
    with pytest.raises(psycopg.Error): indexing.write_prepared(p,conn,models.config)
    assert conn.execute('SELECT count(*) AS n FROM chunks').fetchone()['n']==2
    with pytest.raises(RuntimeError):
        with conn.transaction():
            conn.execute("UPDATE articles SET content=content||'暂存' WHERE id='ragdev_a13'")
            indexing.index('ragdev_a13',models,conn)
            raise RuntimeError('caller abort')
    assert conn.execute("SELECT content FROM articles WHERE id='ragdev_a13'").fetchone()['content']==article['content']


def test_concurrent_snapshot_rejected(db):
    conn,models=db
    article,points=storage.load_article(conn,'ragdev_a13')
    p=indexing.prepare(article,points,models)
    conn.execute('UPDATE decision_points SET "成绩"=\'新成绩\' WHERE id=%s',(points[0]['id'],))
    with pytest.raises(storage.StaleIndexError): indexing.write_prepared(p,conn,models.config)
    assert conn.execute('SELECT count(*) AS n FROM chunks').fetchone()['n']==0


def test_live_embedding_reranker(db):
    if os.getenv('RAG_TEST_LIVE')!='1':
        pytest.skip('set RAG_TEST_LIVE=1 to enable paid API verification')
    conn,_=db
    models=Models(Config.load())
    indexing.index('ragdev_a13',models,conn)
    rows,_=storage.recall(conn,models.config,{},'保研失败后考研',models.embed(['保研失败后考研'])[0])
    scores=models.rerank('保研失败后考研',[r['text'] for r in rows])
    assert rows and len(scores)==len(rows)
