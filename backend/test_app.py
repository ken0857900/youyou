# 不需要数据库的检查：python -m pytest 或直接 python backend/test_app.py
from pathlib import Path

import os

from fastapi.testclient import TestClient

os.environ['AUTH_ALLOW_ID'] = '1'  # 测试直接用账号 ID 当凭证；正式环境只认登录发的 token
os.environ['SEARCH_RAG'] = '0'  # 搜索测试用假文章 t1…，不在库里；RAG 那段由 test_rag_recall 单独测
os.environ['SEARCH_LLM_PARSE'] = '0'  # 搜索测试的假 LLM 没准备处境抽取回答；.env 开着也照关键词版测
os.environ['SEARCH_PER_MIN'] = os.environ['PARSE_PER_MIN'] = '100000'  # 限流另由 test_rate_limit 测

from app.main import app

client = TestClient(app)


def test_health_without_db():
    r = client.get('/api/health').json()
    assert r['ok'] and r['db'] in ('up', 'down')


def test_categories():
    assert len(client.get('/api/categories').json()) == 6


def test_schema_parses():
    try:
        import pglast
    except ImportError:
        return
    pglast.parse_sql((Path(__file__).parent / 'schema.sql').read_text(encoding='utf-8'))


def open_slot(pid):
    # 测试用：在 2099 年随机开一个整点给 pid，回传 startsAt 字串
    import random
    from app.db import connect
    t = f'2099-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}T{random.randint(0, 23):02d}:00'
    with connect() as c:
        c.execute('INSERT INTO availability VALUES (%s, %s) ON CONFLICT DO NOTHING', (pid, t))
    return t


def test_me_flow():
    # 有库才跑：关注 toggle、预约存库里价格、me 列表读得回来
    if client.get('/api/health').json()['db'] != 'up':
        return
    acc = client.post('/api/login', json={'role': 'reader'}).json()['id']
    h = {'X-Account-Id': str(acc)}
    pid = next(p for p in client.get('/api/persons').json() if p.get('price40m'))  # 示例人物没开预约、没价格
    on = client.post(f"/api/persons/{pid['id']}/follow", headers=h).json()['on']
    assert (pid['id'] in client.get('/api/me/follows', headers=h).json()) == on
    client.post(f"/api/persons/{pid['id']}/follow", headers=h)  # 还原
    b = client.post('/api/bookings', headers=h, json={'personId': pid['id'], 'minutes': 40, 'startsAt': open_slot(pid['id']), 'question': 'q', 'price': 1}).json()
    assert b['price'] == pid['price40m'] and b['duration'] == 40 and b['mentorName'] == pid['name']
    assert b['id'] in [x['id'] for x in client.get('/api/me/bookings', headers=h).json()]
    assert client.post('/api/bookings', headers=h, json={'personId': pid['id'], 'minutes': 30, 'startsAt': open_slot(pid['id'])}).status_code == 422
    from app.db import connect
    with connect() as c:
        c.execute('DELETE FROM bookings WHERE id = %s', (int(b['id']),))
        c.execute("DELETE FROM availability WHERE starts_at >= '2099-01-01'")
    assert client.get('/api/me/stars').status_code == 401
    assert isinstance(client.get('/api/me/bookmarks', headers=h).json(), list)


def test_edit_delete_article():
    # 有库才跑：只有作者本人能改／删；用日记（不打 LLM、不进 RAG）
    if client.get('/api/health').json()['db'] != 'up':
        return
    sharer = client.post('/api/login', json={'role': 'sharer'}).json()
    reader = client.post('/api/login', json={'role': 'reader'}).json()
    hs, hr = {'X-Account-Id': str(sharer['id'])}, {'X-Account-Id': str(reader['id'])}
    diary = {'authorId': 'p2', 'type': 'diary', 'title': 'T改删测试', 'content': '原文'}  # authorId 故意填别人
    assert client.post('/api/articles', json=diary).status_code == 401  # 没登录不能发
    assert client.post('/api/articles', json=diary, headers=hr).status_code == 403  # 读者（没验证北大）不能发
    a = client.post('/api/articles', json=diary, headers=hs).json()
    aid = a['id']
    assert a['authorId'] == sharer['personId']  # 作者按登录身份，不照前端传的
    try:
        body = {'title': 'T改删测试2', 'content': '改过的正文'}
        assert client.put(f'/api/articles/{aid}', json=body).status_code == 401
        assert client.put(f'/api/articles/{aid}', json=body, headers=hr).status_code == 403
        assert client.put(f'/api/articles/{aid}', json={**body, 'title': ''}, headers=hs).status_code == 422
        a = client.put(f'/api/articles/{aid}', json=body, headers=hs).json()
        assert a['title'] == 'T改删测试2' and a['content'] == '改过的正文' and a['summary'] == '改过的正文'
        assert client.delete(f'/api/articles/{aid}', headers=hr).status_code == 403
        assert client.delete(f'/api/articles/{aid}', headers=hs).json()['ok']
        assert client.get(f'/api/articles/{aid}').status_code == 404
        assert client.delete('/api/articles/不存在', headers=hs).status_code == 404
    finally:
        from app.db import connect
        with connect() as c:
            c.execute('DELETE FROM articles WHERE id = %s', (aid,))


def test_extract_closed_by_default():
    # 开发用重抽接口：没设 DEV_EXTRACT=1 一律 404，不打 LLM
    old = os.environ.pop('DEV_EXTRACT', None)
    try:
        assert client.post('/api/articles/a1/extract').status_code == 404
    finally:
        if old is not None:
            os.environ['DEV_EXTRACT'] = old


def test_confirmed_points():
    # 作者确认的决策点照样校验：枚举外改「未提及」、原话不在正文就清掉、把握度清空
    pts = A.confirmed_points([{'决策类型': '考研', '学校层级': '清华', '专业': '计算机专业', '原话': '我决定考研',
                               '考虑过的选项': ['保研', '考研'], 'confidence': {'专业': 0.9}},
                              {'决策类型': '保研', '原话': '正文里没有这句'}], '大三那年我决定考研，最后上岸。')
    assert pts[0]['学校层级'] == '未提及' and pts[0]['原话'] == '我决定考研' and pts[0]['confidence'] == {}
    assert pts[0]['专业'] == '计算机'  # 统一成库里写法
    assert pts[0]['考虑过的选项'] == ['保研', '考研'] and pts[1]['原话'] == '未提及' and pts[1]['专业'] == '未提及'
    assert A.confirmed_points(None, 'x') == []


def test_extract_preview_needs_sharer():
    # 预览抽取会花 LLM 钱：没登录 401、读者 403
    if not db_up():
        return
    body = {'title': 't', 'content': 'c'}
    assert client.post('/api/articles/extract', json=body).status_code == 401
    reader = client.post('/api/login', json={'role': 'reader'}).json()
    assert client.post('/api/articles/extract', json=body, headers={'X-Account-Id': str(reader['id'])}).status_code == 403


def test_hero_slides():
    if client.get('/api/health').json()['db'] != 'up':
        return
    h = client.get('/api/hero').json()
    assert h and all(r['url'] and r['season'] and r['title'] and r['credit'] for r in h)


def test_match_level():
    # 红绿灯由程式数：全对 high、至少三分之二 mid、其余 low（07 #11）
    m = A.match_level
    assert m(['九推', '进了光华'], ['九推', '进了光华']) == 'high'
    assert m(['九推'], ['九推', '进了光华']) == 'low'  # 两条只对一条：绿灯
    assert m(['a', 'b', 'c'], ['a', 'b', 'c', 'd']) == 'mid' and m(['a', 'b'], ['a', 'b', 'c', 'd']) == 'low'
    assert m([], ['九推', '进了光华']) == 'low'
    assert m(['a'], ['a', 'b', 'c']) == 'low' and m(['a', 'b'], ['a', 'b', 'c']) == 'mid'
    assert m(['不在条件里'], ['a']) == 'low'


def test_site_images():
    if client.get('/api/health').json()['db'] != 'up':
        return
    keys = {r['key']: r['url'] for r in client.get('/api/site-images').json()}
    assert keys.get('logo') and keys.get('logo_light')


def test_profile_patch():
    if client.get('/api/health').json()['db'] != 'up':
        return
    acc = client.post('/api/login', json={'role': 'sharer'}).json()
    h = {'X-Account-Id': str(acc['id'])}
    orig = client.get(f"/api/persons/{acc['personId']}").json()
    new = {'name': 'T测试', 'tagline': 'tl', 'timeline': [{'year': '2024', 'title': 't', 'desc': 'd'}], 'faqs': [{'q': 'q', 'a': 'a'}], 'price20m': 9}
    try:
        p = client.patch('/api/me/profile', headers=h, json=new).json()
        assert all(p[k] == v for k, v in new.items()) and p['id'] == orig['id']
        assert client.get(f"/api/persons/{acc['personId']}").json()['price20m'] == 9
        assert client.patch('/api/me/profile', headers=h, json={'price40m': -1}).status_code == 422
        assert client.patch('/api/me/profile', headers=h, json={'name': ''}).status_code == 422
        assert client.patch('/api/me/profile', headers=h, json={'name': '  '}).status_code == 422
        assert client.patch('/api/me/profile', headers=h, json={'faqs': [{'q': 'x'}]}).status_code == 422
    finally:
        client.patch('/api/me/profile', headers=h, json={k: orig.get(k) for k in new})
    assert client.get(f"/api/persons/{acc['personId']}").json() == orig
    reader = client.post('/api/login', json={'role': 'reader'}).json()['id']
    assert client.patch('/api/me/profile', headers={'X-Account-Id': str(reader)}, json={'name': 'x'}).status_code == 403


def test_job_publish():
    if client.get('/api/health').json()['db'] != 'up':
        return
    from app.db import connect, one
    co = client.post('/api/login', json={'role': 'company'}).json()
    h = {'X-Account-Id': str(co['id'])}
    body = {'title': 'T测试职位', 'city': '北京', 'salary': '1K', 'majors': ['计算机'], 'decisionTypes': ['求职'], 'deadline': '2026-12-31', 'description': 'd'}
    j = client.post('/api/jobs', headers=h, json=body).json()
    try:
        assert j['title'] == body['title'] and j['official'] and j['company'] == co['name'] and j['deadline'] == '2026-12-31'
        assert j['id'] in [x['id'] for x in client.get('/api/jobs').json()]
        assert j['id'] in [x['id'] for x in client.get('/api/me/jobs', headers=h).json()]
    finally:
        with connect() as c:
            c.execute('DELETE FROM jobs WHERE id = %s', (j['id'],))
    reader = client.post('/api/login', json={'role': 'reader'}).json()['id']
    assert client.post('/api/jobs', headers={'X-Account-Id': str(reader)}, json=body).status_code == 403
    cid = one('SELECT company_id FROM accounts WHERE id = %s', (co['id'],))['company_id']
    with connect() as c:
        c.execute('UPDATE companies SET approved = false WHERE id = %s', (cid,))
    try:
        assert client.post('/api/jobs', headers=h, json=body).status_code == 403
    finally:
        with connect() as c:
            c.execute('UPDATE companies SET approved = %s WHERE id = %s', (co['approved'], cid))


# ---------- AI 部分：假 LLM（不打 DeepSeek） ----------
import json as _json
import time as _time

from app import agents as A
from app import llm

CONTENT = '我是双非计算机大三学生，GPA 3.4。保研名额只有三个，我排第八，所以决定考研，最后考上北大软微。'


def rec(i, tier='双非', major='计算机', author=None):
    dp = {'决策类型': '考研', '学校层级': tier, '专业': major, '成绩': 'GPA 3.4', '年级': '大三', '考虑过的选项': ['保研', '考研'],
          '最后的选择': '考研', '结果': '成功', '结果说明': 'x', '年份': '2024', '原话': CONTENT[:20]}
    return {'id': f't{i}', 'authorId': author or f'p{i}', 'title': f'双非考研{i}', 'summary': '', 'content': CONTENT,
            'stars': 0, 'decisionPoint': dp, 'decisionPoints': [dp]}


def fake(handlers):
    """handlers: {提示词关键字: fn(messages, tools) -> dict 或 JSON 字串}"""
    def chat(messages, tools=None, **_):
        llm.CALLS[0] += 1
        for key, fn in handlers.items():
            if key in messages[0]['content']:
                r = fn(messages, tools)
                return r if isinstance(r, dict) else {'content': r}
        raise AssertionError('没对应的假回答')
    return chat


def with_fake(handlers, fn):
    old = llm.chat, llm.available
    llm.chat, llm.available = fake(handlers), lambda: True
    try:
        return fn()
    finally:
        llm.chat, llm.available = old


def test_extract_validation():
    bad = {'decision_points': [
        {'决策类型': '读博', '学校层级': '一本', '结果': '成功', '年份': 2024, '原话': '这句文章里没有', 'confidence': {'决策类型': 0.3}},
        {'决策类型': '考研', '学校层级': '双非', '原话': CONTENT[10:40], '考虑过的选项': ['保研', '考研']}]}
    pts = with_fake({'决策点抽取员': lambda m, t: _json.dumps(bad, ensure_ascii=False)}, lambda: A.extract_decision_points('t', CONTENT))
    assert pts[0]['决策类型'] == '未提及' and pts[0]['学校层级'] == '未提及' and pts[0]['年份'] == '2024'
    assert pts[0]['原话'] == '未提及' and pts[0]['confidence']['原话'] == 0
    assert pts[1]['原话'] == CONTENT[10:40] and pts[1]['专业'] == '未提及'
    n = [0]  # 第一次 JSON 坏掉 → 重来一次

    def flaky(m, t):
        n[0] += 1
        return 'not json' if n[0] == 1 else _json.dumps(bad, ensure_ascii=False)
    assert len(with_fake({'决策点抽取员': flaky}, lambda: A.extract_decision_points('t', CONTENT))) == 2 and n[0] == 2


def test_verify_quotes():
    assert A.verify_quotes(['保研名额只有三个', '编的', ''], CONTENT) == ['保研名额只有三个']


JUDGE_OK = _json.dumps({'representatives': [{'decision_point_id': 't1', 'why': '同是双非', 'unique': '无',
                                             'quotes': [CONTENT[:15], '编出来的引用']}]}, ensure_ascii=False)


def test_judge_tool_cap():
    records = [rec(1), rec(2)]
    seen = []

    def j(m, tools):
        if tools:  # 一直想调 tool，每次 3 个
            return {'content': '', 'tool_calls': [{'id': f'c{len(m)}{k}', 'type': 'function',
                    'function': {'name': 'get_person_timeline', 'arguments': '{"person_id": "p1"}'}} for k in range(3)]}
        seen.append(sum(1 for x in m if x['role'] == 'tool' and x['content'].startswith('[')))
        return JUDGE_OK
    out, calls = with_fake({'处境判断员': j}, lambda: A.judge({'name': 'g', 'members': records}, {'q': 'q', 'situation': {}, 'records': records}))
    assert calls == 4 and seen == [4], seen  # 真正执行的 timeline 只有 4 次
    reps, dropped = A.check_reps(out, {'members': records})
    assert reps[0]['quotes'] == [CONTENT[:15]] and dropped == 1


def test_reviewer_send_back_then_pass():
    records = [rec(1), rec(2)]
    rounds, prompts = [0], []

    def j(m, tools):
        prompts.append(m[0]['content'])
        return JUDGE_OK

    def rv(m, tools):
        rounds[0] += 1
        return _json.dumps({'pass': rounds[0] > 1, 'problems': [] if rounds[0] > 1 else [{'decision_point_id': 't1', 'reason': '其实是985'}]},
                           ensure_ascii=False)
    ctx = {'q': 'q', 'situation': {}, 'records': records}
    log = A.Log()
    reps = with_fake({'处境判断员': j, '审查员': rv}, lambda: A.run_group({'id': 'g', 'name': 'g', 'members': records}, ctx, log))
    assert [r['decision_point_id'] for r in reps] == ['t1'] and rounds[0] == 2
    assert '上一轮审查意见' in prompts[1] and '其实是985' in prompts[1]
    assert any('打回重判' in s['detail'] for s in log.steps)
    prompts.clear()  # 一直不过：最多打回 2 轮（判断 3 次），只留没被点名的
    never = lambda m, t: '{"pass": false, "problems": [{"decision_point_id": "t1", "reason": "x"}]}'
    reps = with_fake({'处境判断员': j, '审查员': never}, lambda: A.run_group({'id': 'g', 'name': 'g', 'members': records}, ctx, A.Log()))
    assert reps == [] and len(prompts) == 3


SIT = _json.dumps({'irrelevant': False, 'filters': {'决策类型': ['考研'], '学校层级': ['双非'], '专业': ['计算机科学']},
                   'situation': {'学校层级': '双非', '专业': '计算机', '年级': '大三'}}, ensure_ascii=False)


def db_up():
    return client.get('/api/health').json()['db'] == 'up'


def logs_for(q):
    from app.db import query
    return query('SELECT * FROM search_logs WHERE query = %s', (q,))


def cleanup(q):
    if db_up():
        from app.db import connect
        with connect() as c:
            c.execute('DELETE FROM search_logs WHERE query = %s', (q,))


PASS = lambda m, t: '{"pass": true, "problems": []}'
RECS = [rec(1), rec(2), rec(3, tier='985'), rec(4, major='经济学')]


def stream(q, handlers, records=RECS):
    """跑 run_search，收 (kind, data, 当下 LLM 次数)。"""
    A.CACHE.pop(A.cache_key(q, A.S.parse_query(q, records)['filters']), None)
    ev = []
    r = with_fake(handlers, lambda: A.run_search(q, records, 'tester', emit=lambda k, d: ev.append((k, d, llm.CALLS[0]))))
    return r, ev


def by_kind(ev, kind, gid=None):
    return [d for k, d, _ in ev if k == kind and (gid is None or d['id'] == gid)]


def test_search_agent_and_log():
    q = 'T测试双非计算机考研'
    judge = lambda m, t: JUDGE_OK if '"t1"' in m[0]['content'] else '{"not_relevant": true}'
    try:
        n0 = llm.CALLS[0]
        r, ev = stream(q, {'处境判断员': judge, '审查员': PASS})
        assert ev[0][0] == 'step' and [k for k, _, _ in ev].index('result') < 5
        first = next(x for x in ev if x[0] == 'result')
        assert first[2] == n0 and first[1]['source'] == 'keyword'  # 第一个结果在任何 LLM 调用之前
        assert first[1]['filters']['专业'] == ['计算机'] and [g['id'] for g in first[1]['groups']] == ['same', 'better-extra']
        same = by_kind(ev, 'group', 'same')[0]
        assert same['why']['t1']['why'] == '同是双非' and same['members'][0] == 't1' and same['why']['t1']['quotes'] == [CONTENT[:15]]
        assert by_kind(ev, 'group', 'better-extra')[0]['members'] == []  # 整群不像 → 前端拿掉
        assert by_kind(ev, 'review', 'same') == [{'id': 'same', 'group': '跟你最像', 'pass': True}]
        assert ev[-1][0] == 'done' and r['source'] == 'agent' and r['llmCalls'] == ev[-1][1]['llmCalls'] == 3
        steps = [s['step'] for s in r['steps']]
        assert steps[:3] == ['①', '②③', '④'] and '⑦' in steps and steps[-1] == '完成', steps
        if db_up():
            row = logs_for(q)[0]
            assert row['viewer'] == 'tester' and row['result_count'] == 2 and not row['fallback'] and len(row['steps']) == len(r['steps'])
    finally:
        cleanup(q)


def test_stream_order_and_send_back():
    q = 'T测试双非计算机考研打回'
    rounds = [0]

    def rv(m, t):
        rounds[0] += 1
        return PASS(m, t) if rounds[0] > 1 else '{"pass": false, "problems": [{"decision_point_id": "t1", "reason": "其实是985"}]}'
    judge = lambda m, t: JUDGE_OK if '"t1"' in m[0]['content'] else '{"not_relevant": true}'
    try:
        _, ev = stream(q, {'处境判断员': judge, '审查员': rv})
        same = [(k, d) for k, d, _ in ev if k in ('group', 'review') and d['id'] == 'same']
        assert [k for k, _ in same] == ['group', 'group', 'review'] and same[-1][1]['pass']  # 群先出、打回后更新、再审过
    finally:
        cleanup(q)


def test_timeout_leaves_group_plain():
    q = 'T测试双非计算机考研超时'

    def judge(m, t):
        if '【这一群】起点比你好' in m[0]['content']:
            _time.sleep(1)
        return JUDGE_OK if '"t1"' in m[0]['content'] else '{"not_relevant": true}'
    old, A.AGENT_TIMEOUT = A.AGENT_TIMEOUT, 0.5
    try:
        r, ev = stream(q, {'处境判断员': judge, '审查员': PASS})
        assert by_kind(ev, 'group', 'same') and not by_kind(ev, 'group', 'better-extra')  # 没判断完的群不推，前端维持关键词版
        assert ev[-1][0] == 'done' and any(s['step'] == '超时' for s in r['steps'])
        assert A.cached(A.cache_key(q, r['filters'])) is None  # 没跑完不进缓存
        if db_up():
            assert logs_for(q)[0]['fallback']
    finally:
        A.AGENT_TIMEOUT = old
        _time.sleep(0.6)  # 等迟到的线程跑完，别混进下个测试的计数
        cleanup(q)


def test_cache_hit():
    q = 'T测试双非计算机考研缓存'
    judge = lambda m, t: JUDGE_OK if '"t1"' in m[0]['content'] else '{"not_relevant": true}'
    try:
        _, ev1 = stream(q, {'处境判断员': judge, '审查员': PASS})
        ev2 = []
        r = with_fake({}, lambda: A.run_search(q, RECS, emit=lambda k, d: ev2.append((k, d))))
        assert r['llmCalls'] == 0 and r['source'] == 'cache'
        strip = lambda ev: [(k, d) for k, d, *_ in ev if k in ('group', 'review')]
        assert strip(ev1) == strip(ev2) and ev2[-1][1]['cachedAt']
        assert any(s['step'] == '缓存' and '命中缓存' in s['label'] for s in r['steps'])
    finally:
        cleanup(q)


def test_search_keyword_without_llm():
    old, llm.available = llm.available, lambda: False
    q = 'T测试双非计算机考研kw'
    try:
        r = A.run_search(q, [rec(1)])
        assert r['source'] == 'keyword' and r['results'] == ['t1'] and r['llmCalls'] == 0
    finally:
        llm.available = old
        cleanup(q)


def test_rag_recall():
    """RAG 候选 → 文章：按 rerank 排、同篇只留一次（取排最前的决策点）、库里没有的丢掉；RAG 出错退回关键词。"""
    dp = lambda tier: {**rec(0)['decisionPoint'], '学校层级': tier, 'id': 99, 'article_id': 'x'}
    cands = [{'article_id': 't2', 'decision_point': dp('211')}, {'article_id': 'gone', 'decision_point': dp('985')},
             {'article_id': 't1', 'decision_point': dp('985')}, {'article_id': 't2', 'decision_point': dp('双非')}]
    old_env, old_run = os.environ.pop('SEARCH_RAG'), A.RAG.retrieval.run
    parsed = A.S.parse_query('双非计算机考研', RECS)
    try:
        A.RAG.retrieval.run = lambda q, m, f: {'status': 'ok', 'candidates': cands, 'degraded': ['situation_rules_fallback'], 'elapsed_ms': 5}
        out, how = A.rag_recall('q', RECS, parsed)
        assert [a['id'] for a in out] == ['t2', 't1'] and out[0]['decisionPoint']['学校层级'] == '211'
        assert set(out[0]['decisionPoint']) == set(rec(0)['decisionPoint']) and '降级' not in how
        A.RAG.retrieval.run = lambda q, m, f: {'status': 'service_error', 'error': {'message': 'db'}}
        out, how = A.rag_recall('q', RECS, parsed)
        assert '关键词版' in how and out == A.S.search(RECS, parsed)
    finally:
        os.environ['SEARCH_RAG'], A.RAG.retrieval.run = old_env, old_run


def test_parse_filters_without_llm():
    # 主题／热门页「用说的」：LLM 不可用退回关键词，只回四个栏位
    old, llm.available = llm.available, lambda: False
    try:
        r = client.get('/api/filters/parse', params={'q': '双非计算机考研'}).json()
        assert r['filters'] == {'决策类型': ['考研'], '学校层级': ['双非'], '专业': ['计算机'], '结果': []} and r['source'] == '关键词'
        assert isinstance(r['results'], list)  # 召回的文章 id，页面按这个排
        assert client.get('/api/filters/parse', params={'q': 'x' * 201}).status_code == 422
    finally:
        llm.available = old


def test_prompts_loaded():
    assert set(llm.PROMPTS) == {'extract', 'situation', 'judge', 'review', 'fallback', 'invite', 'calendar', 'claims', 'rules', 'fresh_judge', 'list_why'}
    assert '{title}' in llm.PROMPTS['extract'] and '{judge_output}' in llm.PROMPTS['review']


def test_ratings():
    if client.get('/api/health').json()['db'] != 'up':
        return
    from app.db import connect
    reader = client.post('/api/login', json={'role': 'reader'}).json()['id']
    sharer = client.post('/api/login', json={'role': 'sharer'}).json()['id']
    hr, hs = {'X-Account-Id': str(reader)}, {'X-Account-Id': str(sharer)}
    art = client.get('/api/articles').json()[0]
    pid, aid = art['authorId'], art['id']
    before = client.get(f'/api/articles/{aid}/helpful').json()['count']
    helped0 = client.get(f'/api/persons/{pid}/stats').json()['helpedCount']
    bid = None
    try:
        assert client.post(f'/api/articles/{aid}/helpful', json={}).status_code == 401
        assert client.post(f'/api/articles/{aid}/helpful', headers=hr, json={'comment': 'x' * 201}).status_code == 422
        r = client.post(f'/api/articles/{aid}/helpful', headers=hr, json={'comment': '很有用'}).json()
        assert r['count'] == before + 1 and r['mine'] and any(c['comment'] == '很有用' for c in r['comments'])
        r = client.post(f'/api/articles/{aid}/helpful', headers=hr, json={'comment': '改了'}).json()  # upsert 不重复计
        assert r['count'] == before + 1 and not any(c['comment'] == '很有用' for c in r['comments'])
        assert not client.get(f'/api/articles/{aid}/helpful', headers=hs).json()['mine']
        other = [a for a in client.get(f'/api/articles?author={pid}').json() if a['id'] != aid]
        if other:  # 同一人点同作者两篇只算 1 人
            client.post(f"/api/articles/{other[0]['id']}/helpful", headers=hr, json={})
        assert client.get(f'/api/persons/{pid}/stats').json()['helpedCount'] == helped0 + 1
        board = client.get('/api/leaderboard/helpful?limit=50').json()
        assert [b['helpedCount'] for b in board] == sorted([b['helpedCount'] for b in board], reverse=True)
        assert any(b['id'] == pid for b in board)
        assert client.delete(f'/api/articles/{aid}/helpful', headers=hr).json()['count'] == before
        # 咨询评分：只有本人、只一次、1–5 星
        bid = client.post('/api/bookings', headers=hr, json={'personId': pid, 'minutes': 20, 'startsAt': open_slot(pid)}).json()['id']
        url = f'/api/bookings/{bid}/complete-review'
        assert client.post(url, headers=hs, json={'stars': 5}).status_code == 403
        assert client.post(url, headers=hr, json={'stars': 6}).status_code == 422
        assert client.post(url, headers=hr, json={'stars': 0}).status_code == 422
        n0 = client.get(f'/api/persons/{pid}/stats').json()['ratingCount']
        assert client.post(url, headers=hr, json={'stars': 4, 'comment': '讲得清楚'}).json()['review']['stars'] == 4
        assert client.post(url, headers=hr, json={'stars': 1}).status_code == 409
        st = client.get(f'/api/persons/{pid}/stats').json()
        assert st['ratingCount'] == n0 + 1 and st['recentReviews'][0]['comment'] == '讲得清楚' and 1 <= st['ratingAvg'] <= 5
    finally:
        with connect() as c:
            c.execute('DELETE FROM article_helpful WHERE account_id = %s', (reader,))
            if bid:
                c.execute('DELETE FROM bookings WHERE id = %s', (int(bid),))


def test_uploads():
    import io
    from PIL import Image
    from app.main import UPLOADS
    if client.get('/api/health').json()['db'] != 'up':
        return
    acc = client.post('/api/login', json={'role': 'sharer'}).json()
    h = {'X-Account-Id': str(acc['id'])}
    up = lambda data, name='x.jpg', purpose='article', hd=h: client.post('/api/uploads', headers=hd, data={'purpose': purpose}, files={'file': (name, data)})
    assert up(b'x', hd={}).status_code == 401
    assert up(b'<?php echo 1; ?>', 'evil.jpg').status_code == 415
    gif = io.BytesIO(); Image.new('RGB', (5, 5)).save(gif, 'GIF')
    assert up(gif.getvalue(), 'a.png').status_code == 415
    assert up(b'\xff' * (5 * 1024 * 1024 + 1)).status_code == 413
    # 带 GPS 的 JPEG：存下来的档不能有任何 EXIF
    exif = Image.Exif(); exif[0x010F] = 'Cam'; exif[0x8825] = {2: (25.0, 2.0, 0.0), 1: 'N'}
    buf = io.BytesIO(); Image.new('RGB', (3000, 1000), 'red').save(buf, 'JPEG', exif=exif)
    assert Image.open(io.BytesIO(buf.getvalue())).getexif().get_ifd(0x8825)
    saved = []
    orig = client.get(f"/api/persons/{acc['personId']}").json()
    try:
        url = up(buf.getvalue()).json()['url']; saved.append(url)
        with Image.open(UPLOADS / url.split('/')[-1]) as img:
            assert not img.getexif() and 'exif' not in img.info and max(img.size) == 1600
        av = up(buf.getvalue(), purpose='avatar').json()['url']; saved.append(av)
        with Image.open(UPLOADS / av.split('/')[-1]) as img:
            assert img.size == (400, 400)
        assert client.patch('/api/me/profile', headers=h, json={'avatar': av}).json()['avatar'] == av
        assert client.patch('/api/me/profile', headers=h, json={'avatar': 'javascript:alert(1)'}).status_code == 422
    finally:
        client.patch('/api/me/profile', headers=h, json={'avatar': orig['avatar']})
        for u in saved:
            (UPLOADS / u.split('/')[-1]).unlink(missing_ok=True)


def test_strip_images():
    from app.agents import strip_images
    assert strip_images('甲\n\n![](/uploads/ab12.jpg)\n\n乙').split() == ['甲', '乙']
    assert '![](' in strip_images('行内 ![](/uploads/a.jpg) 不算')



class FakeConn:
    def __init__(self, rows): self.rows = rows
    def execute(self, *a): return self
    def fetchall(self): return self.rows


def sharer_row(pid, aid, stars, **dp):
    base = {f: '未提及' for f in A.MATCH_FIELDS}
    return {'id': pid, 'profile': {'title': pid}, 'aid': aid, 'title': f'{pid} 的文章', 'stars': stars, **base, **dp}


def test_pick_sharers():
    rows = [sharer_row('p1', 'a1', 1, 学校层级='双非', 专业='计算机'), sharer_row('p2', 'a2', 9, 学校层级='双非'),
            sharer_row('p3', 'a3', 50), sharer_row('p1', 'a1', 1, 学校层级='双非')]  # p1 一篇两个决策点
    # 规则：对上越多越前，p3 一个都没对上不选，不叫 LLM
    assert A.pick_sharers(FakeConn(rows), 'q', {'学校层级': '双非/211', '专业': '计算机'}) == (['p1', 'p2'], 'rule')
    # 都对不上 → agent；编造的 id、重复的会被去掉
    agent = {'读者想看的经验': lambda m, t: '{"picks": [{"person_id": "p3"}, {"person_id": "ghost"}, {"person_id": "p3"}, {"person_id": "p1"}]}'}
    assert with_fake(agent, lambda: A.pick_sharers(FakeConn(rows), '医学转金融', {})) == (['p3', 'p1'], 'agent')
    # 没 key → 推荐数最高
    old = llm.chat
    llm.chat = lambda *a, **k: (_ for _ in ()).throw(llm.LLMUnavailable('x'))
    try:
        assert A.pick_sharers(FakeConn(rows), '医学转金融', {}) == (['p3', 'p2', 'p1'], 'top')
    finally:
        llm.chat = old



def test_pay_qr():
    if not db_up():
        return
    from app.db import connect
    reader = client.post('/api/login', json={'role': 'reader'}).json()['id']
    sharer = client.post('/api/login', json={'role': 'sharer'})
    hr, hs = {'X-Account-Id': str(reader)}, {'X-Account-Id': str(sharer.json()['id'])}
    pid = sharer.json()['personId']
    # 收款码只收自己上传的图
    assert client.patch('/api/me/profile', json={'payQr': 'https://evil.example/qr.png'}, headers=hs).status_code == 422
    assert client.patch('/api/me/profile', json={'payQr': '/uploads/qr.png'}, headers=hs).json()['payQr'] == '/uploads/qr.png'
    b = client.post('/api/bookings', json={'personId': pid, 'minutes': 20, 'startsAt': open_slot(pid)}, headers=hr).json()
    assert b['payQr'] == '/uploads/qr.png' and b['paid'] is False
    try:
        assert client.post(f"/api/bookings/{b['id']}/paid", headers=hs).status_code == 403  # 不是自己的预约
        assert client.post(f"/api/bookings/{b['id']}/paid", headers=hr).json()['paid'] is True
        client.post(f"/api/bookings/{b['id']}/paid", headers=hr)  # 按两次只通知一次
        paid = [n for n in client.get('/api/notifications', headers=hs).json() if n['type'] == 'paid' and b['slot'] in n['text']]
        assert len(paid) == 1
        # 分享者看得到别人约他的单（含付款状态），读者那边没有人物页 → 空
        mine = [x for x in client.get('/api/me/incoming-bookings', headers=hs).json() if x['id'] == b['id']]
        assert len(mine) == 1 and mine[0]['paid'] is True and mine[0]['readerName']
        assert client.get('/api/me/incoming-bookings').status_code == 401
    finally:
        with connect() as c:
            c.execute("DELETE FROM notifications WHERE type = 'paid' AND text LIKE %s", ('%2099-%',))
            c.execute('DELETE FROM bookings WHERE id = %s', (int(b['id']),))
        client.patch('/api/me/profile', json={'payQr': ''}, headers=hs)


def test_availability():
    if not db_up():
        return
    from app.db import connect
    reader = client.post('/api/login', json={'role': 'reader'}).json()['id']
    sharer = client.post('/api/login', json={'role': 'sharer'}).json()
    hr, hs, pid = {'X-Account-Id': str(reader)}, {'X-Account-Id': str(sharer['id'])}, sharer['personId']
    a, b2 = '2099-03-02T09:00', '2099-03-02T23:00'
    try:
        assert client.put('/api/me/availability', headers=hr, json={'month': '2099-03', 'slots': [a]}).status_code == 403  # 读者不能设
        rows = client.put('/api/me/availability', headers=hs, json={'month': '2099-03', 'slots': [a, b2, '2099-04-01T10:00']}).json()
        assert [r['t'] for r in rows] == [a, b2]  # 别的月份的不收
        assert client.get(f'/api/persons/{pid}/slots?month=2099-03').json() == [a, b2]
        bk = client.post('/api/bookings', headers=hr, json={'personId': pid, 'minutes': 20, 'startsAt': a})
        assert bk.json()['slot'] == '2099-03-02（周一）09:00'
        assert client.post('/api/bookings', headers=hr, json={'personId': pid, 'minutes': 20, 'startsAt': a}).status_code == 409  # 约走了
        assert client.post('/api/bookings', headers=hr, json={'personId': pid, 'minutes': 20, 'startsAt': '2099-03-03T09:00'}).status_code == 409  # 没开放
        assert client.get(f'/api/persons/{pid}/slots?month=2099-03').json() == [b2]  # 读者看不到约走的
        rows = client.put('/api/me/availability', headers=hs, json={'month': '2099-03', 'slots': []}).json()
        assert rows == [{'t': a, 'booked': True}]  # 约走的拿不掉
        assert client.post('/api/bookings', headers=hr, json={'personId': pid, 'minutes': 20, 'startsAt': '2020-01-01T09:00'}).status_code == 409  # 过去的
    finally:
        with connect() as c:
            c.execute("DELETE FROM bookings WHERE starts_at >= '2099-01-01'")
            c.execute("DELETE FROM availability WHERE starts_at >= '2099-01-01'")


def test_calendar_rules():
    from datetime import datetime
    now = datetime(2026, 10, 17, 12)  # 星期六中午
    R = lambda **k: A.CalRule.model_validate(k)
    # 下周一到五晚上 8–11 点，周三除外：10/19–10/23 去掉 10/21，每天 20、21、22 点
    got = A.expand_rules([R(**{'from': '2026-10-19', 'to': '2026-10-23'}, weekdays=[1, 2, 4, 5], hours=[20, 21, 22])], '2026-10', set(), set(), now)
    assert len(got) == 12 and '2026-10-21T20:00' not in got and got[0] == '2026-10-19T20:00'
    # 今天下午以后才算、跨月的不收、坏的小时丢掉
    got = A.expand_rules([R(dates=['2026-10-17', '2026-11-02'], hours=[9, 14, 25])], '2026-10', set(), set(), now)
    assert got == ['2026-10-17T14:00']
    # remove 不删已被约走的
    cur = {'2026-10-25T10:00', '2026-10-25T11:00'}
    got = A.expand_rules([R(action='remove', dates=['2026-10-25'])], '2026-10', cur, {'2026-10-25T10:00'}, now)
    assert got == ['2026-10-25T10:00']
    # agent 说没听懂 → 不动、回问句
    ask = {'时间设定助手': lambda m, t: '{"rules": [], "note": "", "ask": "你说的周末是这周还是每周？"}'}
    out = with_fake(ask, lambda: A.calendar_assist('周末可以', '2026-10', cur, set(), now))
    assert out['slots'] == sorted(cur) and '周末' in out['ask']
    # add 没给几点：不当全天，回问句
    nohour = {'时间设定助手': lambda m, t: '{"rules": [{"action": "add", "dates": ["2026-10-26"]}], "note": "", "ask": ""}'}
    out = with_fake(nohour, lambda: A.calendar_assist('下周一有空', '2026-10', cur, set(), now))
    assert out['slots'] == sorted(cur) and '几点' in out['ask']

    # 读者端：有空的时间跟分享者可约时段取交集
    if db_up():
        from app.db import connect
        reader = client.post('/api/login', json={'role': 'reader'}).json()['id']
        pid = client.post('/api/login', json={'role': 'sharer'}).json()['personId']
        with connect() as c:
            for t in ('2099-05-02T10:00', '2099-05-02T15:00', '2099-05-03T15:00'):
                c.execute('INSERT INTO availability VALUES (%s, %s) ON CONFLICT DO NOTHING', (pid, t))
        pm = {'时间设定助手': lambda m, t: '{"rules": [{"action": "add", "dates": ["2099-05-02", "2099-05-03"], "hours": [13, 14, 15, 16]}], "note": "下午 = 13–16 点"}'}
        try:
            out = with_fake(pm, lambda: client.post(f'/api/persons/{pid}/slots/assist', headers={'X-Account-Id': str(reader)},
                                                   json={'month': '2099-05', 'text': '周末下午'}).json())
            assert out['matches'] == ['2099-05-02T15:00', '2099-05-03T15:00'] and out['note']
            assert client.post(f'/api/persons/{pid}/slots/assist', json={'month': '2099-05', 'text': 'x'}).status_code == 401
        finally:
            with connect() as c:
                c.execute("DELETE FROM availability WHERE starts_at >= '2099-01-01'")


def test_email_auth():
    if not db_up():
        return
    import re
    from app import main as M
    from app.db import connect
    sent = []
    old_send = M.send_mail
    M.send_mail = lambda to, subject, body: sent.append((to, re.search(r'\d{6}', subject).group()))
    os.environ['AUTH_ALLOW_ID'] = '0'
    e, pku, s2 = 'authtest@example.com', 'authtest@pku.edu.cn', 'authtest2@stu.pku.edu.cn'
    try:
        assert client.post('/api/auth/send-code', json={'email': 'bad'}).status_code == 422
        assert client.post('/api/auth/send-code', json={'email': e}).json()['ok']
        assert client.post('/api/auth/send-code', json={'email': e}).status_code == 429  # 60 秒内不能重寄
        code = sent[-1][1]
        wrong = '000000' if code != '000000' else '111111'
        for _ in range(4):
            assert client.post('/api/auth/verify', json={'email': e, 'code': wrong, 'password': 'pw123456'}).status_code == 400
        assert client.post('/api/auth/verify', json={'email': e, 'code': code, 'password': 'short'}).status_code == 422  # 密码至少 8 位
        acc = client.post('/api/auth/verify', json={'email': e, 'code': code, 'password': 'pw123456'}).json()
        assert acc['role'] == 'reader' and acc['token'] and 'password_hash' not in acc
        assert client.post('/api/auth/verify', json={'email': e, 'code': code, 'password': 'pw123456'}).status_code == 400  # 只能用一次
        # 之后用密码登录，不用验证码；错 5 次锁住
        assert client.post('/api/auth/password-login', json={'email': e.upper(), 'password': 'pw123456'}).json()['id'] == acc['id']
        assert client.post('/api/auth/password-login', json={'email': 'nobody@example.com', 'password': 'pw123456'}).status_code == 400
        for _ in range(5):
            assert client.post('/api/auth/password-login', json={'email': e, 'password': 'wrongpass'}).status_code == 400
        assert client.post('/api/auth/password-login', json={'email': e, 'password': 'pw123456'}).status_code == 429
        M.LOGIN_FAILS.clear()
        h = {'X-Account-Id': acc['token']}
        assert client.get('/api/me/follows', headers=h).status_code == 200
        assert client.get('/api/me/follows', headers={'X-Account-Id': str(acc['id'])}).status_code == 401  # 不认纯 ID
        # 北大邮箱升级
        assert client.post('/api/auth/send-code', json={'email': e, 'purpose': 'pku_verify'}, headers=h).status_code == 422
        assert client.post('/api/auth/send-code', json={'email': 'x@notpku.edu.cn', 'purpose': 'pku_verify'}, headers=h).status_code == 422
        assert client.post('/api/auth/send-code', json={'email': 'authtest@stu.pku.edu.cn', 'purpose': 'pku_verify'}, headers=h).json()['ok']
        assert client.post('/api/auth/send-code', json={'email': pku, 'purpose': 'pku_verify'}).status_code == 401
        client.post('/api/auth/send-code', json={'email': pku, 'purpose': 'pku_verify'}, headers=h)
        up = client.post('/api/auth/pku-verify', json={'email': pku, 'code': sent[-1][1]}, headers=h).json()
        assert up['role'] == 'sharer' and up['pkuVerified'] and up['personId'] == f"u{acc['id']}"
        assert client.get(f"/api/persons/{up['personId']}").json()['name'] == 'authtest'
        # 直接用北大邮箱登录 → 自动升级分享者，不用再验一次
        client.post('/api/auth/send-code', json={'email': s2})
        acc2 = client.post('/api/auth/verify', json={'email': s2, 'code': sent[-1][1], 'password': 'pw123456'}).json()
        assert acc2['role'] == 'sharer' and acc2['pkuVerified'] and acc2['personId'] == f"u{acc2['id']}"
        # 登出后 token 失效
        client.post('/api/logout', headers=h)
        assert client.get('/api/me/follows', headers=h).status_code == 401
    finally:
        M.send_mail = old_send
        os.environ['AUTH_ALLOW_ID'] = '1'
        with connect() as c:
            c.execute('DELETE FROM email_codes WHERE email IN (%s, %s, %s, %s)', (e, pku, 'authtest@stu.pku.edu.cn', s2))
            for x in (e, s2):
                c.execute('UPDATE accounts SET person_id = NULL WHERE email = %s', (x,))
                c.execute("DELETE FROM persons WHERE id IN (SELECT 'u' || id FROM accounts WHERE email = %s)", (x,))
                c.execute('DELETE FROM accounts WHERE email = %s', (x,))


if __name__ == '__main__':
    test_ratings()
    test_health_without_db(); test_categories(); test_schema_parses(); test_me_flow(); test_edit_delete_article(); test_extract_closed_by_default(); test_confirmed_points(); test_extract_preview_needs_sharer(); test_hero_slides(); test_site_images(); test_match_level(); test_profile_patch(); test_job_publish()
    test_prompts_loaded(); test_verify_quotes(); test_extract_validation(); test_judge_tool_cap(); test_reviewer_send_back_then_pass()
    test_search_agent_and_log(); test_stream_order_and_send_back(); test_timeout_leaves_group_plain(); test_cache_hit(); test_search_keyword_without_llm(); test_rag_recall(); test_parse_filters_without_llm()
    test_uploads(); test_strip_images(); test_pick_sharers(); test_pay_qr(); test_availability(); test_calendar_rules(); test_email_auth()
    print('ok')


def test_rate_limit_and_parse_cache():
    # 搜索／AI 帮我选按 IP 限流；AI 帮我选同一句话走缓存不重打 LLM；只信本机 nginx 转来的 X-Real-IP
    from app import main as M
    old = (M.SEARCH_PER_MIN, M.PARSE_PER_MIN, A.parse_situation)
    calls = []
    M.HITS.clear(); M.PARSE_CACHE.clear()
    try:
        M.SEARCH_PER_MIN, M.PARSE_PER_MIN = 2, 2
        old_llm, llm.available = llm.available, lambda: False  # stream 只测限流，不跑 agent
        try:
            codes = [client.get('/api/search/stream', params={'q': '考研'}).status_code for _ in range(3)]
        finally:
            llm.available = old_llm
        assert codes == [200, 200, 429], codes
        assert client.get('/api/search/stream', params={'q': 'x' * 201}).status_code == 422
        kw = old[2]  # 假 LLM：形状照关键词版（召回要用 textHits 等），来源标 llm 才会缓存
        A.parse_situation = lambda q, r, use_llm=None: (calls.append(q) or (kw(q, r, use_llm=False)[0], 'llm'))
        for _ in range(5):  # 同一句：只打一次 LLM、也不吃限流
            assert client.get('/api/filters/parse', params={'q': '双非 考研'}).json()['filters']['决策类型'] == ['考研']
        assert calls == ['双非 考研']
        assert client.get('/api/filters/parse', params={'q': '第二句'}).status_code == 200
        assert client.get('/api/filters/parse', params={'q': '第三句'}).status_code == 429
        # TestClient 的来源不是 127.0.0.1 → 伪造 X-Real-IP 换不到新额度
        assert client.get('/api/filters/parse', params={'q': '第四句'}, headers={'X-Real-IP': '1.2.3.4'}).status_code == 429
    finally:
        M.SEARCH_PER_MIN, M.PARSE_PER_MIN, A.parse_situation = old
        M.HITS.clear(); M.PARSE_CACHE.clear()
