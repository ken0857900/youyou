"""Ken 的 AI 部分：流程 A 决策点抽取、流程 B 搜索 agent 层（docs/03、提示词 docs/07）。
程式做得到的用程式（分群、统计、引用核验），agent 只做判断（⑤）和审查（⑦）。"""
import os
import sys
from pathlib import Path
import json
import re
import threading
import time
from datetime import date, datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator
from psycopg.types.json import Jsonb

from . import llm
from . import search as S
from .db import connect, one, DATABASE_URL

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # 仓库根目录，才 import 得到同学的 RAG/
import RAG  # noqa: E402

NA = '未提及'
ENUMS = {
    '决策类型': {'保研', '考研', '出国', '求职', '考公', '选导师'},
    '学校层级': {'985', '211', '双非'},
    '结果': {'成功', '失败', '转向'},
}
AGENT_TIMEOUT = int(os.getenv('AGENT_TIMEOUT', '45'))  # 整个 agent 层（⑤–⑦）时限，没判断完的群维持关键词版
MAX_TOOL_CALLS = 4      # 每个判断 agent 最多调用 get_person_timeline 次数
MAX_SEND_BACK = 2       # 审查最多打回轮数
DEFAULT_PURPOSE = '找做决定前的处境最像读者的人'
MAX_MEMBERS = 8         # ponytail: 每群只给判断 agent 前 8 人（已按 rerank 排），群大了再分批


IMG_RE = re.compile(r'^!\[\]\(/uploads/[\w.-]+\)\s*$', re.M)


def strip_images(text):
    """文章里独占一行的图片标记 ![](/uploads/x.jpg) 不进 LLM、不进关键词比对。"""
    return IMG_RE.sub('', text or '')


def verify_quotes(quotes, text):
    """⑥ 引用核验（程式）：只留逐字出现在 text 里的句子（忽略空白差异）。
    TODO: RAG 同学的引用核验函数上线后可替换这里。"""
    norm = lambda s: re.sub(r'\s+', '', s or '')
    t = norm(text)
    return [q for q in quotes if norm(q) and norm(q) in t]


# ---------- 流程 A：决策点抽取（07 #1） ----------
class DecisionPoint(BaseModel):
    model_config = ConfigDict(extra='ignore')
    决策类型: str = NA
    学校层级: str = NA
    专业: str = NA
    成绩: str = NA
    年级: str = NA
    考虑过的选项: list[str] = []
    最后的选择: str = NA
    结果: str = NA
    结果说明: str = NA
    年份: str = NA
    原话: str = NA
    confidence: dict[str, float] = {}

    @field_validator('决策类型', '学校层级', '专业', '成绩', '年级', '最后的选择', '结果', '结果说明', '年份', '原话', mode='before')
    @classmethod
    def to_text(cls, v):
        return NA if v in (None, '') else str(v).strip()

    @field_validator('考虑过的选项', mode='before')
    @classmethod
    def to_list(cls, v):
        return [str(x) for x in v] if isinstance(v, list) else []

    @field_validator('confidence', mode='before')
    @classmethod
    def to_conf(cls, v):  # 把握度不是数字的栏丢掉，不让整篇失败
        return {k: float(x) for k, x in v.items() if isinstance(x, (int, float))} if isinstance(v, dict) else {}

    def model_post_init(self, _):
        for f, ok in ENUMS.items():  # 枚举外的值一律「未提及」
            if getattr(self, f) not in ok:
                setattr(self, f, NA)
        if self.专业 != NA:  # 「计算机专业」「软件工程」→ 库里写法「计算机」，筛选才对得上
            self.专业 = norm_major(self.专业)


class Extraction(BaseModel):
    decision_points: list[DecisionPoint] = []


def author_background(pid):
    """作者自己填的本科出身，给抽取当【作者资料】（07 #1 第 3 条）。"""
    r = one('SELECT school_tier, major FROM persons WHERE id = %s', (pid,)) if pid else None
    return {'学校层级': r['school_tier'] if r else None, '专业': r['major'] if r else None}


def extract_decision_points(title, content, author=None):
    """回 dict 列表（DP 11 栏 + confidence）。author＝{学校层级, 专业}：作者本科出身，文中没写时照这个填，不让模型从内文猜。
    LLM 不可用抛 LLMUnavailable。"""
    content = strip_images(content)
    author = author or {'学校层级': None, '专业': None}
    out = llm.ask([{'role': 'user', 'content': llm.fill('extract', title=title, content=content, author=author)}], Extraction)
    points = []
    for p in out.decision_points:
        if p.原话 != NA and not verify_quotes([p.原话], content):  # 原话必须逐字摘自全文
            p.原话 = NA
            p.confidence['原话'] = 0.0
        points.append(p.model_dump())
    return points


def confirmed_points(points, content):
    """作者在写作页确认／改过的决策点：照抽取同一套规则校验——枚举外改「未提及」、
    原话必须逐字出现在正文（作者手改的也一样），把握度清空（已经人工确认）。"""
    out = []
    for p in points or []:
        dp = DecisionPoint.model_validate({k: v for k, v in p.items() if k != 'confidence'})
        if dp.原话 != NA and not verify_quotes([dp.原话], strip_images(content)):
            dp.原话 = NA
        out.append(dp.model_dump())
    return out


def save_points(c, aid, points):
    """一篇文章的决策点整批重写；category 跟第一个决策点的决策类型。"""
    c.execute('DELETE FROM decision_points WHERE article_id = %s', (aid,))
    for p in points:
        p = {**p, '专业': S.major_category(p.get('专业'))}  # 发文、改文、汇入都走这里：专业归成固定大类
        row = {**{k: v for k, v in p.items() if k != 'confidence'}, 'confidence': Jsonb(p.get('confidence', {}))}
        c.execute(f'INSERT INTO decision_points (article_id, {", ".join(chr(34) + k + chr(34) for k in row)}) '
                  f'VALUES (%s, {", ".join(["%s"] * len(row))})', [aid, *row.values()])


# ---------- 流程 B：搜索 ----------
class Log:
    """每步 {step, label, detail, ms}，可选 emit 推给 SSE。"""
    def __init__(self, emit=None):
        self.steps, self.emit = [], emit

    def add(self, step, label, detail, t0):
        s = {'step': step, 'label': label, 'detail': detail, 'ms': int((time.time() - t0) * 1000)}
        self.steps.append(s)
        if self.emit:
            self.emit(s)


class Situation(BaseModel):
    irrelevant: bool = False
    query: str = ''  # 改正错字／同音字后的检索句（光滑 → 光华管理学院），拿去 RAG
    filters: dict[str, list[str]] = {}
    situation: dict[str, Optional[str]] = {}




def norm_major(m):
    # LLM 给的专业名对齐库里的固定大类（计算机科学 → 计算机）；归不进大类（「光华学院硕士」→ 其他）就不当条件
    cat = S.major_category(m) if m else None
    return None if cat in ('其他', '未提及') else cat


def parse_situation(q, records, use_llm=None):
    """① 处境抽取：有 key 用 07 #2，否则（或出错）用关键词版。回 (parsed, 'llm'|'keyword')，形状同 S.parse_query。
    use_llm=None 看 SEARCH_LLM_PARSE（本机与线上 .env 都设 1）；True＝主题／热门页「用说的」强制用 LLM。"""
    kw = S.parse_query(q, records)
    if use_llm is None:
        use_llm = os.getenv('SEARCH_LLM_PARSE') == '1'
    if not use_llm or not llm.available() or not q.strip():
        return kw, '关键词'
    try:
        out = llm.ask([{'role': 'user', 'content': llm.fill('situation', query=q)}], Situation, temperature=0)  # 同一句每次抽得一样（改错字才稳）
    except (llm.LLMUnavailable, ValueError) as e:
        return kw, f'关键词（LLM 不可用：{str(e)[:60]}）'
    filters = {f: [] for f in [*S.FILTER_FIELDS, S.PATH_FIELD]}
    for f, vals in out.filters.items():
        if f in ENUMS:
            filters[f] = [v for v in vals if v in ENUMS[f]]
        elif f == '专业':  # 归不进大类的（LLM 把「光华学院硕士」当专业）norm_major 回 None，不筛
            filters[f] = [m for m in dict.fromkeys(norm_major(v) for v in vals if v) if m]
    s = out.situation
    tier = s.get('学校层级') if s.get('学校层级') in ENUMS['学校层级'] else None
    situation = {'学校层级': tier, '专业': norm_major(s.get('专业')), '年级': s.get('年级'), '成绩': s.get('成绩')}
    labels = [v for vals in filters.values() for v in vals] + [x for x in (situation['年级'], situation['成绩']) if x]
    rewritten = out.query.strip()[:200].translate(S.T2S)
    return {'filters': filters, 'labels': labels, 'textHits': kw['textHits'], 'situation': situation,
            'irrelevant': out.irrelevant, 'query': rewritten if rewritten and rewritten != q else None}, 'llm'


def dp_view(a):
    return {'decision_point_id': a['id'], 'person_id': a['authorId'], **a['decisionPoint']}


def person_timeline(records, pid):
    return [{'decision_point_id': a['id'], 'title': a['title'], 'decision_points': a['decisionPoints']}
            for a in records if a['authorId'] == pid]


TOOLS = [{'type': 'function', 'function': {
    'name': 'get_person_timeline', 'description': '回传某位分享者所有文章的决策点（看他前后的经历）',
    'parameters': {'type': 'object', 'properties': {'person_id': {'type': 'string'}}, 'required': ['person_id']}}}]


class Rep(BaseModel):
    decision_point_id: str
    why: str
    unique: str = '无'
    quotes: list[str] = []


class Judge(BaseModel):
    not_relevant: bool = False
    representatives: list[Rep] = Field(default=[])


class Problem(BaseModel):
    decision_point_id: str = ''
    reason: str = ''


class Review(BaseModel):
    passed: bool = Field(alias='pass')
    problems: list[Problem] = []


def judge(group, ctx, problems=None):
    """⑤ 判断 agent：tool 循环最多 MAX_TOOL_CALLS 次。回 (Judge, tool 调用次数)。"""
    prompt = llm.fill('judge', situation=ctx['situation'], query=ctx['q'], group_name=group['name'],
                      group_purpose=group.get('purpose', DEFAULT_PURPOSE),
                      n=str(len(group['members'])), decision_points=[dp_view(a) for a in group['members'][:MAX_MEMBERS]])
    if problems:
        prompt += '\n【上一轮审查意见】' + json.dumps(problems, ensure_ascii=False)
    messages = [{'role': 'user', 'content': prompt}]
    calls = 0
    msg = llm.chat(messages, TOOLS)
    while msg.get('tool_calls') and calls < MAX_TOOL_CALLS:
        messages.append({'role': 'assistant', 'content': msg.get('content') or '', 'tool_calls': msg['tool_calls']})
        for tc in msg['tool_calls']:
            calls += 1
            if calls > MAX_TOOL_CALLS:
                result = {'error': '已达调用上限，请直接输出结论'}
            else:
                try:
                    pid = json.loads(tc['function'].get('arguments') or '{}').get('person_id')
                except ValueError:
                    pid = None
                result = person_timeline(ctx['records'], pid)
            messages.append({'role': 'tool', 'tool_call_id': tc['id'], 'content': json.dumps(result, ensure_ascii=False, default=str)})
        msg = llm.chat(messages, TOOLS if calls < MAX_TOOL_CALLS else None)
    if msg.get('tool_calls'):  # 到上限还想调：不带 tools 再要一次结论
        msg = llm.chat(messages)
    return llm.ask(messages, Judge, msg), min(calls, MAX_TOOL_CALLS)


def quote_source(a):
    """引用核验对照的原文：全文＋各决策点原话；原话是「未提及」的不算，不然「未提及」三个字也能当引用通过。"""
    return a['content'] + ''.join(d['原话'] for d in a['decisionPoints'] if d.get('原话') and d['原话'] != NA)


def check_reps(out, group):
    """⑥：代表必须在这群里，最多 2 人；quotes 原文查不到就删。回 (reps, 删掉几句)。"""
    by_id = {a['id']: a for a in group['members']}
    reps, dropped = [], 0
    for r in out.representatives:
        a = by_id.get(r.decision_point_id)
        if not a or len(reps) == 2:
            continue
        source = quote_source(a)
        kept = verify_quotes(r.quotes, source)
        dropped += len(r.quotes) - len(kept)
        reps.append({**r.model_dump(), 'quotes': kept})
    return reps, dropped


def agent_group(group, reps):
    """agent 版的一群：代表排前面，带 why/unique/quotes。reps=None（整群不像）→ members 空，前端拿掉这群。"""
    if reps is None:
        return {**ids([group])[0], 'members': [], 'why': {}}
    rep_ids = [r['decision_point_id'] for r in reps]
    members = sorted(group['members'], key=lambda a: rep_ids.index(a['id']) if a['id'] in rep_ids else 99)
    return {**ids([group])[0], 'members': [a['id'] for a in members], 'why': {r['decision_point_id']: r for r in reps}}


def run_group(group, ctx, log, send=lambda kind, data: None):
    """⑤⇄⑦ evaluator-optimizer：判断 → 核验 → 马上 send('group') → 审查（send('review')），不过带意见重判，最多打回 2 轮。
    回代表列表，整群不像回 None。"""
    name, problems, reps = group['name'], None, []
    for rnd in range(1 + MAX_SEND_BACK):
        t = time.time()
        out, calls = judge(group, ctx, problems)
        if out.not_relevant:
            log.add('⑤', f'判断 agent「{name}」', f'第 {rnd + 1} 轮：整群跟你不像，不显示', t)
            send('group', agent_group(group, None))
            return None
        reps, dropped = check_reps(out, group)
        log.add('⑤', f'判断 agent「{name}」',
                f'第 {rnd + 1} 轮：调用 get_person_timeline {calls} 次，选 {len(reps)} 人', t)
        log.add('⑥', f'引用核验「{name}」', f'删掉 {dropped} 句原文查不到的引用' if dropped else '引用全部查得到', t)
        if not reps:
            return []
        send('group', agent_group(group, reps))
        t = time.time()
        cited = [dp_view(a) for a in group['members'] if a['id'] in {r['decision_point_id'] for r in reps}]
        rv = llm.ask([{'role': 'user', 'content': llm.fill('review', situation=ctx['situation'], query=ctx['q'],
                                                           group_name=name, group_purpose=group.get('purpose', DEFAULT_PURPOSE),
                                                           judge_output={'representatives': reps}, decision_points=cited)}], Review)
        problems = [p.model_dump() for p in rv.problems]
        if rv.passed:
            log.add('⑦', f'审查 agent「{name}」', '通过', t)
            send('review', {'id': group['id'], 'group': name, 'pass': True})
            return reps
        last = rnd == MAX_SEND_BACK
        log.add('⑦', f'审查 agent「{name}」',
                f'不通过（{"；".join(p["reason"] for p in problems)[:120]}）' + ('→ 只留没被点名的代表' if last else '→ 打回重判'), t)
    bad = {p['decision_point_id'] for p in problems}
    reps = [r for r in reps if r['decision_point_id'] not in bad]
    send('group', agent_group(group, reps))
    send('review', {'id': group['id'], 'group': name, 'pass': False})
    return reps


class WhyRep(Rep):
    matched: list[str] = []  # conditions 里这篇对上的那几条；红绿灯由 match_level 照比例算


class Whys(BaseModel):
    conditions: list[str] = []  # 先把读者的话拆成条件写出来，matched 只拿这些对（07 #11）
    items: list[WhyRep] = []


WHY_BATCH, WHY_MAX = 8, 30  # 一次问 8 篇（输出不会太长），几批平行；最多 30 篇＝RAG 召回上限，有 AI 结果的每篇都有红绿灯


def match_level(matched, conditions):
    """红绿灯：全对 high、对上至少三分之二 mid、其余 low（绿＝可能会想看）。两个条件只对上一个是 low。
    数数交给程式（07 #11），模型只判断每条对不对得上。"""
    hit = len(set(matched) & set(conditions))
    if not conditions:
        return 'mid'
    return 'high' if hit == len(conditions) else 'mid' if hit * 3 >= len(conditions) * 2 else 'low'


def why_batch(q, situation, arts, conditions=()):
    """conditions：先拆好的条件，几批共用同一份（每批各拆会拆得不一样，同样的经历在不同批灯号不同）；空的就这批自己拆。"""
    out = llm.ask([{'role': 'user', 'content': llm.fill('list_why', situation=situation, query=q, conditions=list(conditions),
                                                       decision_points=[{**dp_view(a), '文章标题': a['title']} for a in arts])}], Whys, temperature=0)  # 带标题：决策点只写「高金」，标题才看得出是光华高金
    conditions = list(conditions) or out.conditions
    by_id, res = {a['id']: a for a in arts}, {}
    for r in out.items:
        a = by_id.get(r.decision_point_id)
        if a and a['id'] not in res:
            source = quote_source(a)
            quotes = verify_quotes(r.quotes, source)
            # hit＝对上几条：搜索页灯全绿时，只把 hit > 0 的当「猜你想看」（一条都没对上＝完全无关，不硬凑）
            res[a['id']] = {'why': r.why, 'unique': r.unique, 'quotes': quotes, 'match': match_level(r.matched, conditions),
                            'hit': len(set(r.matched) & set(conditions))}
    return res


def list_why(q, situation, articles):
    """主题／热门／人物页「AI 帮我选」的推荐理由（07 #11）：召回的文章每 WHY_BATCH 篇一批平行问，原话照 ⑥ 核验。
    回 {文章 id: {why, unique, quotes}}；某批失败就少那批，全失败才抛错。"""
    arts = articles[:WHY_MAX]
    batches = [arts[i:i + WHY_BATCH] for i in range(0, len(arts), WHY_BATCH)]
    if not batches:
        return {}
    try:  # 先只拆条件（不给文章，输出很短），几批共用；拆失败就各批自己拆
        conditions = llm.ask([{'role': 'user', 'content': llm.fill('list_why', situation=situation, query=q, conditions=[],
                                                                    decision_points=[])}], Whys, temperature=0).conditions
    except (llm.LLMUnavailable, ValueError):
        conditions = []
    with ThreadPoolExecutor(max_workers=len(batches)) as pool:
        futs = [pool.submit(why_batch, q, situation, b, conditions) for b in batches]
    res, errs = {}, []
    for f in futs:
        try:
            res.update(f.result())
        except (llm.LLMUnavailable, ValueError) as e:
            errs.append(e)
    if errs and not res:
        raise errs[0]
    return res


def ids(groups):
    return [{**g, 'members': [a['id'] for a in g['members']]} for g in groups]


def rag_index(c, aid):
    """发文／重抽的同一交易里给 RAG 入库（save_points 删了重建，必须同交易）。
    入库失败（没硅基 key、没建 chunks）只回滚入库这段、文章照发，之后补跑 python -m RAG rebuild。"""
    try:
        with c.transaction():
            RAG.index_article(aid, connection=c)
    except (RAG.ServiceError, RAG.DatabaseError, ValueError) as e:
        print(f'[RAG] 文章 {aid} 入库失败，之后跑 python -m RAG rebuild：{type(e).__name__}: {e}')
    clear_caches()  # 有新证据，旧的 agent 输出作废


def rag_recall(q, records, parsed):
    """②③ 同学的 RAG（SQL 过滤 + 向量／全文 + RRF + reranker）。①用我们的 parsed（filters 全传＝覆盖 RAG 自动抽取）。
    RAG 出错（库没建 chunks、没 key）退回关键词版。回 (文章列表按 rerank 排, 说明)。
    一篇命中多个决策点：取排最前的那个当 decisionPoint，文章只出现一次。"""
    if os.getenv('SEARCH_RAG') == '0':  # 测试（假文章不在库里）或 RAG 出事时一键退回
        return S.search(records, parsed), '关键词版（SEARCH_RAG=0）'
    models = RAG.Models(RAG.Config.load())
    models.config.database_url = DATABASE_URL  # 用后端改过 127.0.0.1 的，不然 Windows 每条连接白等 3 秒
    models.config.llm_key = ''  # ①已经做过，不让 RAG 再打一次 LLM（deepseek-flash 没关思考会慢）
    try:
        out = RAG.retrieval.run(q, models, parsed['filters'])
    except (ValueError, RAG.ServiceError, RAG.DatabaseError) as e:
        out = {'status': 'service_error', 'error': {'message': str(e)[:60]}}
    if out['status'] == 'service_error':
        return S.search(records, parsed), f"关键词版（RAG 不可用：{out.get('error', {}).get('message', '')[:60]}）"
    by_id, results = {r['id']: r for r in records}, []
    for c in out['candidates']:
        a = by_id.get(c['article_id'])
        if a:
            results.append({**a, 'decisionPoint': {k: c['decision_point'].get(k) for k in a['decisionPoint']}})
            by_id[c['article_id']] = None  # 已收
    degraded = [d for d in out['degraded'] if d != 'situation_rules_fallback']  # 规则版是我们故意关的
    deg = f"，降级：{'/'.join(degraded)}" if degraded else ''
    return results, f"RAG 向量＋全文＋{'rerank' if 'reranker_unavailable' not in out['degraded'] else 'RRF'}，{out['elapsed_ms']} ms{deg}"


CACHE_TTL = int(os.getenv('SEARCH_CACHE_TTL', '1800'))
# ponytail: 进程内 dict，重启就没、多 worker 不共享；要共享再放 Redis/库
CACHE = {}  # key -> (生成时间, agent 事件列表 [(kind, data)])
WHY_CACHE = {}  # 「AI 帮我选」推荐理由：句子 -> {文章 id: 理由}（main.filters_why 用）


def clear_caches():
    """文章发布／改／删时调：搜索 agent 输出和推荐理由都可能引用旧文章、漏掉新文章。"""
    CACHE.clear()
    WHY_CACHE.clear()


def cache_key(q, filters):
    return re.sub(r'\s+', '', q.lower()) + json.dumps(filters, ensure_ascii=False, sort_keys=True)


def cached(key):
    hit = CACHE.get(key)
    return hit if hit and time.time() - hit[0] < CACHE_TTL else None


def run_search(q, records, viewer=None, emit=None):
    """流程 B。emit(kind, data)：先 result（关键词版，不打 LLM），再每群 group / review，最后 done。
    回 result 形状 + llmCalls。"""
    emit = emit or (lambda kind, data: None)
    q = q.translate(S.T2S)  # 繁体问句转简体，关键词和 RAG 全文检索才对得上
    closed = threading.Event()  # done 之后迟到的群不再推
    log = Log(lambda s: closed.is_set() or emit('step', s))
    t0, calls0 = time.time(), llm.CALLS[0]
    t = time.time()
    parsed, how = parse_situation(q, records)
    picked = {k: '/'.join(v) for k, v in parsed['filters'].items() if v}
    rq = parsed.get('query') or q  # LLM 改正错字后的检索句；没改就用原句
    log.add('①', '处境抽取', f"{'LLM' if how == 'llm' else how}：{json.dumps(picked, ensure_ascii=False)}"
            + (f'；改写检索句：{rq}' if rq != q else '')
            + ('（无关问题，只显示分类入口）' if parsed['irrelevant'] else ''), t)
    t = time.time()
    results, how = ([], '无关问题') if parsed['irrelevant'] else rag_recall(rq, records, parsed)
    log.add('②③', '召回＋排序', f'{len(results)} 条（{how}）', t)
    t = time.time()
    groups = S.group_results(results, parsed['situation'])
    extra = None
    if results and S.TIER_RANK.get(parsed['situation']['学校层级']) in (1, 2) and not any(g['id'] == 'better' for g in groups):
        relaxed = {**parsed, 'filters': {**parsed['filters'], '学校层级': []}}  # 起点比你好：清掉学校层级再搜一次
        extra = S.better_group(rag_recall(rq, records, relaxed)[0], parsed, groups)
    if extra:
        groups.append(extra)
    log.add('④', '分群＋统计（程式）', ' / '.join(f"{g['name']} {len(g['members'])}" for g in groups)
            + ('（含不套学校层级筛选的「起点比你好」）' if extra else ''), t)
    res = {**parsed, 'results': [a['id'] for a in results], 'groups': ids(groups), 'steps': log.steps, 'source': 'keyword'}
    emit('result', {**res, 'steps': list(log.steps)})  # 复本：res 之后还会改

    key, events, timed_out = cache_key(q, parsed['filters']), [], False
    hit = cached(key) if results else None
    if hit:
        t = time.time()
        for kind, data in hit[1]:
            emit(kind, data)
        events = hit[1]
        log.add('缓存', f"命中缓存（首次由 agent 生成于 {time.strftime('%H:%M', time.localtime(hit[0]))}）", f'{len(events)} 个 agent 输出', t)
        res['source'] = 'cache'
    elif results and llm.available():
        def send(kind, data):
            if not closed.is_set():
                events.append((kind, data))
                emit(kind, data)
        ctx = {'q': rq, 'situation': parsed['situation'], 'records': records}
        pool = ThreadPoolExecutor(max_workers=max(1, len(groups)))
        futs = [pool.submit(run_group, g, ctx, log, send) for g in groups]
        _, pending = wait(futs, timeout=AGENT_TIMEOUT)
        # ponytail: 超时的线程拿不回来，只是不等它（closed 挡住之后的推送）；要真中断得改 async + 取消 httpx 请求
        pool.shutdown(wait=False, cancel_futures=True)
        errs = [f.exception() for f in futs if f not in pending and f.exception()]
        timed_out = bool(pending)
        if pending or errs:
            log.add('超时', '没判断完的群维持关键词版', f'{len(pending)} 群超过 {AGENT_TIMEOUT} 秒'
                    + (f'；{len(errs)} 群出错：{type(errs[0]).__name__}: {str(errs[0])[:80]}' if errs else ''), t0)
        else:
            CACHE[key] = (time.time(), list(events))  # 只缓存每群都审完的
        res['source'] = 'agent'

    log.add('完成', '完成', f'LLM 调用 {llm.CALLS[0] - calls0} 次', t0)
    closed.set()
    res['llmCalls'] = llm.CALLS[0] - calls0
    emit('done', {'steps': log.steps, 'llmCalls': res['llmCalls'], 'cachedAt': hit[0] if hit else None})
    try:
        with connect() as c:
            c.execute('INSERT INTO search_logs (query, viewer, steps, result_count, fallback) VALUES (%s,%s,%s,%s,%s)',
                      (q, viewer, Jsonb(log.steps), len(res['results']), timed_out))
    except Exception:
        pass  # 没库也照样回结果
    return res


# ---------- 求经验：邀请分享者（docs/05 求经验 ③） ----------
WISH_NOTIFY_AT = 5  # 想看的人数到这个数才邀请分享者，只发一次
MATCH_FIELDS = ['决策类型', '学校层级', '专业', '结果', '年级', '年份']


class Pick(BaseModel):
    person_id: str
    reason: str = ''


class Picks(BaseModel):
    picks: list[Pick]


def pick_sharers(c, q, conditions, n=5):
    """规则先比对条件；一个都对不上才交给 agent（07 #6）；agent 不可用取推荐数最高。回 ([person_id], 'rule'|'agent'|'top')"""
    cols = ', '.join(f'dp."{f}"' for f in MATCH_FIELDS)
    rows = c.execute(f'SELECT p.id, p.profile, a.id AS aid, a.title, a.stars, {cols} FROM persons p '
                     "JOIN articles a ON a.author_id = p.id AND a.type = 'article' "
                     'LEFT JOIN decision_points dp ON dp.article_id = a.id').fetchall()
    conds = {k: str(v).split('/') for k, v in (conditions or {}).items() if k in MATCH_FIELDS and v}
    people = {}
    for r in rows:
        p = people.setdefault(r['id'], {'profile': r['profile'] or {}, 'titles': {}, 'score': 0})
        p['titles'][r['aid']] = (r['title'], r['stars'])  # 一篇多个决策点时只算一次
        p['score'] = max(p['score'], sum(r[k] in v for k, v in conds.items()))
    stars = lambda pid: sum(s for _, s in people[pid]['titles'].values())
    hits = sorted((pid for pid, p in people.items() if p['score'] > 0), key=lambda pid: (-people[pid]['score'], -stars(pid)))
    if hits:
        return hits[:n], 'rule'
    try:
        sharers = [{'id': pid, 'title': p['profile'].get('title', ''), 'tagline': p['profile'].get('tagline', ''),
                    'articles': [t for t, _ in p['titles'].values()]} for pid, p in people.items()]
        out = llm.ask([{'role': 'user', 'content': llm.fill('invite', query=q, conditions=conditions or '无', sharers=sharers)}], Picks)
        picks = list(dict.fromkeys(x.person_id for x in out.picks if x.person_id in people))[:n]  # 去掉编造的 id、重复的
        if picks:
            return picks, 'agent'
    except (llm.LLMUnavailable, ValueError):
        pass
    return sorted(people, key=lambda pid: -stars(pid))[:n], 'top'


# ---------- 日历助手（07 #7）：一句话 → 规则 → 程式展开成时段 ----------
class CalRule(BaseModel):
    action: str = 'add'
    from_: Optional[str] = Field(None, alias='from')
    to: Optional[str] = None
    dates: list[str] = []
    weekdays: list[int] = []
    hours: list[int] = []


class CalOut(BaseModel):
    rules: list[CalRule] = []
    note: str = ''
    ask: str = ''


def _day(s):
    try:
        return date.fromisoformat(s) if s else None
    except ValueError:
        return None


def expand_rules(rules, month, current, booked, now):
    """规则套到 month（'YYYY-MM'）上：current 是目前时段字串集合；过去的不动、booked 的不删。回排好的新集合。"""
    first = date.fromisoformat(month + '-01')
    nxt = (first + timedelta(days=32)).replace(day=1)
    slots = set(current)
    for r in rules:
        if r.dates:
            days = [d for d in map(_day, r.dates) if d]
        else:
            lo, hi = max(_day(r.from_) or first, first), min(_day(r.to) or nxt - timedelta(days=1), nxt - timedelta(days=1))
            days = [lo + timedelta(days=i) for i in range((hi - lo).days + 1)]
        days = [d for d in days if first <= d < nxt and (not r.weekdays or d.isoweekday() in r.weekdays)]
        hours = [h for h in (r.hours or range(24)) if 0 <= h <= 23]
        for d in days:
            for h in hours:
                t = f'{d:%Y-%m-%d}T{h:02d}:00'
                if datetime.fromisoformat(t) <= now:
                    continue
                if r.action == 'remove':
                    if t not in booked:
                        slots.discard(t)
                else:
                    slots.add(t)
    return sorted(slots)


def calendar_assist(text, month, current, booked, now):
    """回 {'slots', 'note', 'ask'}；LLM 不可用抛 LLMUnavailable。"""
    out = llm.ask([{'role': 'user', 'content': llm.fill(
        'calendar', today=f'{now:%Y-%m-%d}', weekday='一二三四五六日'[now.weekday()], month=month,
        current=sorted(current) or '无', text=text)}], CalOut)
    if out.ask or not out.rules:
        return {'slots': sorted(current), 'note': out.note, 'ask': out.ask or '没听懂，可以说得具体一点吗？例：下周一到五晚上 8 点到 11 点'}
    if any(r.action != 'remove' and not r.hours for r in out.rules):  # 没说几点不当全天，不然会开出凌晨 3 点
        return {'slots': sorted(current), 'note': out.note, 'ask': '大概几点方便？例：晚上 8 点到 11 点'}
    return {'slots': expand_rules(out.rules, month, current, booked, now), 'note': out.note, 'ask': ''}
