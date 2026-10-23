# 流程 D 保鲜度：假 LLM、真库（没库就跳过）。python -m pytest backend/test_freshness.py
import json
from datetime import date

from app import freshness as F, llm
from app.db import connect

NOTICE = '2099年夏令营通知\n三、申请时间\n2099 年6 月1 日00:00-6 月16 日中午12:00\n特别提示：不可兼报学术夏令营。'
ARTICLE = '我申请光华。光华金融硕士夏令营分三批申请，第一批没进会自动延续。\n\n光华专硕营和学术营不能兼报。\n\n光华推荐信要5封。'


def fake_chat(messages, tools=None, temperature=None):
    p = messages[-1]['content']
    if '招生规则整理员' in p:
        out = {'rules': [{'rule_type': '申请时间与批次', 'content': '6/1–6/16 一次', 'quote': '2099 年6 月1 日00:00-6 月16 日中午12:00'},
                         {'rule_type': '兼报限制', 'content': '不可兼报', 'quote': '不可兼报学术夏令营'},
                         {'rule_type': '申请时间与批次', 'content': '统计学到 6/21', 'quote': '6 月16 日'},  # 同类型第二条：要合并不能盖掉
                         {'rule_type': '学费', 'content': '不在枚举', 'quote': '特别提示'},
                         {'rule_type': '开营时间', 'content': '编的', 'quote': '通知里没有这句'}]}
    elif '主张抽取员' in p:
        out = {'claims': [{'sentence': '光华金融硕士夏令营分三批申请，第一批没进会自动延续。', 'program': '专硕夏令营', 'rule_type': '申请时间与批次'},
                          {'sentence': '光华专硕营和学术营不能兼报。', 'program': '专硕夏令营', 'rule_type': '兼报限制'},
                          {'sentence': '光华推荐信要5封。', 'program': '专硕夏令营', 'rule_type': '推荐信'},
                          {'sentence': '文章里没有这句', 'program': '专硕夏令营', 'rule_type': '兼报限制'}]}
    else:  # 判断：分批那句判 changed，兼报那句判 valid 但引用是编的 → 程式降成 unknown
        ids = [c['id'] for c in json.loads(p.split('【要判断的句子】（id、句子、文章发表年份）\n')[1].split('\n\n')[0])]
        quote = '2099 年6 月1 日00:00-6 月16 日中午12:00' if '申请时间与批次' in p else '编出来的原文'
        out = {'judgments': [{'id': i, 'status': 'changed' if '申请时间与批次' in p else 'valid', 'reason': 'r', 'quote': quote} for i in ids]}
    return {'content': json.dumps(out, ensure_ascii=False)}


def has_db():
    try:
        with connect() as c:
            c.execute('SELECT 1 FROM claims LIMIT 1')
        return True
    except Exception:
        return False


def test_status_of():
    assert F.status_of('valid', 2025, date(2026, 3, 1)) == 'pending'  # 今年通知还没出
    assert F.status_of('valid', 2026, date(2026, 10, 1)) == 'valid'
    assert F.status_of('changed', 2025, date(2026, 3, 1)) == 'changed'


def test_list_items():
    page = '<a href="../info/1/2.htm">2026年光华夏令营通知</a><a href="../info/1/3.htm">招生专业目录</a>'
    assert F.list_items(page, 'http://x.cn/mfin/zsxx/zsjz1.htm') == [('http://x.cn/mfin/info/1/2.htm', '2026年光华夏令营通知')]


def test_flow(monkeypatch):
    if not has_db():
        return
    monkeypatch.setattr(llm, 'chat', fake_chat)
    with connect() as c:
        nid = c.execute("INSERT INTO notices (url, title, program, year, text) VALUES ('test://n', 't', '专硕夏令营', 2099, %s) "
                        'ON CONFLICT (url) DO UPDATE SET text = EXCLUDED.text RETURNING id', (NOTICE,)).fetchone()['id']
        assert F.extract_rules(c, nid) == 2  # 枚举外、引用对不上的丢掉；同类型合并
        merged = c.execute("SELECT content FROM rules WHERE notice_id = %s AND rule_type = '申请时间与批次'", (nid,)).fetchone()
        assert '统计学' in merged['content'] and '一次' in merged['content']
        c.execute("INSERT INTO persons (id, name) VALUES ('fresh_t', 't') ON CONFLICT DO NOTHING")
        aid = c.execute("INSERT INTO articles (author_id, type, category, title, content) VALUES ('fresh_t', 'article', '保研', 't', %s) "
                        'RETURNING id', (ARTICLE,)).fetchone()['id']
    try:
        assert F.index_article(aid) == 3  # 文章里没有的那句丢掉
        with connect() as c:
            got = {x['rule_type']: x for x in F.article_claims(c, aid, today=date(2099, 7, 1))}
        assert got['申请时间与批次']['status'] == 'changed' and got['申请时间与批次']['year'] == 2099
        assert got['兼报限制']['status'] == 'unknown' and got['兼报限制']['quote'] == ''  # 引用编的
        assert got['推荐信']['status'] == 'unknown'  # 假判断给的引用是编的

        def boom(*a, **k):
            raise llm.LLMUnavailable('down')
        monkeypatch.setattr(llm, 'chat', boom)
        F.index_safe(aid)  # LLM 出错：旧主张要留着
        with connect() as c:
            assert len(F.article_claims(c, aid)) == 3
    finally:
        with connect() as c:
            c.execute('DELETE FROM articles WHERE id = %s', (aid,))
            c.execute("DELETE FROM persons WHERE id = 'fresh_t'")
            c.execute('DELETE FROM notices WHERE id = %s', (nid,))
