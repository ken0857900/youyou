"""流程 D：经验保鲜度核验（只做光华，docs/03、提示词 docs/07 #8–#10）。
爬光华夏令营通知 → 抽成规则（07 #9）→ 文章里的客观主张（07 #8）按 (program, rule_type) 挂到最新规则
→ 一条规则一次判断底下所有主张（07 #10）。主张挂规则、引用核验、待更新都是程式做，LLM 只抽和判。

用法（backend 目录）：
  python -m app.freshness crawl            抓列表页，新通知才入库、抽规则、重判受影响的主张（每天 cron 跑）
  python -m app.freshness index [aid ...]  对文章抽主张并判断；不给 aid＝全部含「光华」的文章
  python -m app.freshness recheck          所有规则重判一次（改了 07 #10 之后用）"""
import html
import io
import re
import ssl
import sys
import threading
from datetime import date
from pathlib import Path

import certifi
import httpx
from pydantic import BaseModel, field_validator

from . import llm
from .agents import strip_images, verify_quotes
from .db import connect

BASE = 'http://www.gsm.pku.edu.cn'  # 官网 https 偶尔握手失败，http 稳定
# ponytail: 列表页写死（光华三个项目共用同一份专硕通知，只盯金融硕士和学术硕博）；要扩到别的学院再做成表
LISTS = {
    '专硕夏令营': ['/mfin/zsxx/zsjz1.htm', '/mfin/zsxx/zsjz1/1.htm'],
    '学术夏令营': ['/graduate/zsxx1/zsjz.htm', '/graduate/zsxx1/zsjz/1.htm', '/graduate/zsxx1/zsjz/2.htm'],
}
PROGRAMS = set(LISTS)
RULE_TYPES = {'申请时间与批次', '开营时间', '申请资格', '成绩单与排名', '英语证明', '推荐信', '项目方向', '兼报限制'}
KEYWORD = '光华'


# 官网（从伺服器连会被 302 到 https）没送中继凭证、只接受旧套件，补上 RapidSSL G1（2027-11 到期，到时重抓 cacerts.digicert.com）
TLS = ssl.create_default_context(cafile=certifi.where())
TLS.load_verify_locations(Path(__file__).with_name('rapidssl_g1.pem'))
TLS.set_ciphers('DEFAULT:AES128-SHA')  # 官网只接受这个旧套件（TLS1.2 RSA），Python 默认清单没有


def get(url):
    r = httpx.get(url, timeout=20, follow_redirects=True, verify=TLS, headers={'User-Agent': 'Mozilla/5.0 PathFinder-freshness'})
    r.raise_for_status()
    return r


def pdf_text(data):
    from pypdf import PdfReader  # 只有爬虫用到，不拖慢后端启动
    return ''.join(p.extract_text() or '' for p in PdfReader(io.BytesIO(data)).pages)


def list_items(page_html, page_url):
    """列表页 → [(网址, 标题)]，只要标题有「夏令营」和年份的。"""
    out = []
    for href, title in re.findall(r'<a [^>]*href="([^"]*info/[^"]+\.htm)"[^>]*>(.*?)</a>', page_html, re.S):
        title = html.unescape(re.sub(r'<[^>]+>', '', title)).strip()
        if '夏令营' in title and re.search(r'20\d\d', title):
            out.append((str(httpx.URL(page_url).join(href)), title))
    return out


def notice_text(page_html, page_url, fetch=get):
    """通知页：正文是嵌的 PDF 就抓 PDF，否则取页面文字。回 (text, pdf_url)。"""
    m = re.search(r'(?:src|href)="([^"]+\.pdf)"', page_html)
    if m:
        pdf_url = str(httpx.URL(page_url).join(m.group(1)))
        return pdf_text(fetch(pdf_url).content), pdf_url
    body = re.sub(r'(?s)<script.*?</script>|<style.*?</style>', '', page_html)
    return html.unescape(re.sub(r'<[^>]+>', '\n', body)), None


# ---------- 07 #9：通知 → 规则 ----------
class Rule(BaseModel):
    rule_type: str
    content: str
    quote: str = ''


class Rules(BaseModel):
    rules: list[Rule] = []


def extract_rules(c, nid):
    """一份通知抽规则；类型不在枚举、引用对不上原文的丢掉。同 (program, rule_type, year) 覆盖。回存了几条。"""
    n = c.execute('SELECT * FROM notices WHERE id = %s', (nid,)).fetchone()
    out = llm.ask([{'role': 'user', 'content': llm.fill('rules', year=str(n['year']), program=n['program'],
                                                         title=n['title'], text=n['text'])}], Rules, temperature=0)
    merged = {}  # 同类型多条（金融、会计各一条申请时间）合成一条，不然后一条盖掉前一条
    for r in out.rules:
        if r.rule_type in RULE_TYPES and verify_quotes([r.quote], n['text']):
            m = merged.setdefault(r.rule_type, {'content': [], 'quote': r.quote})
            m['content'].append(r.content.strip())
    for rule_type, m in merged.items():
        c.execute('INSERT INTO rules (program, rule_type, year, content, quote, notice_id) VALUES (%s,%s,%s,%s,%s,%s) '
                  'ON CONFLICT (program, rule_type, year) DO UPDATE SET content = EXCLUDED.content, quote = EXCLUDED.quote, '
                  'notice_id = EXCLUDED.notice_id', (n['program'], rule_type, n['year'], '；'.join(m['content']), m['quote'], nid))
    return len(merged)


def crawl(fetch=get):
    """抓列表页，新通知才入库并抽规则，再重判这些通知涉及的 (program, rule_type)。回新通知标题列表。"""
    new = []
    for program, pages in LISTS.items():
        for path in pages:
            url = BASE + path
            try:
                items = list_items(fetch(url).text, url)
            except httpx.HTTPError as e:
                print(f'  ⚠️ 列表页抓不到 {url}：{type(e).__name__}')
                continue
            for link, title in items:
                with connect() as c:
                    if c.execute('SELECT 1 FROM notices WHERE url = %s', (link,)).fetchone():
                        continue
                text, pdf_url = notice_text(fetch(link).text, link, fetch)
                year = int(re.search(r'20\d\d', title).group())
                with connect() as c:
                    nid = c.execute('INSERT INTO notices (url, title, program, year, pdf_url, text) VALUES (%s,%s,%s,%s,%s,%s) '
                                    'RETURNING id', (link, title, program, year, pdf_url, text)).fetchone()['id']
                    n = extract_rules(c, nid)
                print(f'  ✓ {year} {program}：{title}（{n} 条规则）')
                new.append((program, title))
    for program in {p for p, _ in new}:
        recheck(program)
    return [t for _, t in new]


# ---------- 07 #8：文章 → 主张 ----------
class Claim(BaseModel):
    sentence: str
    program: str
    rule_type: str


class Claims(BaseModel):
    claims: list[Claim] = []


_LOCKS = {}  # ponytail: 单进程内按文章加锁；多 worker 部署要换 pg_advisory_lock


def index_article(aid):
    """抽一篇文章的主张（整批重写）并判断。没提到光华的只清掉旧主张，不叫 LLM。回主张数。
    LLM 成功后才删旧插新（同一交易），LLM 出错旧标注保留；同一篇同时只跑一个。"""
    with _LOCKS.setdefault(aid, threading.Lock()):
        with connect() as c:
            a = c.execute('SELECT title, content, type FROM articles WHERE id = %s', (aid,)).fetchone()
        if not a or a['type'] != 'article' or KEYWORD not in a['content']:
            with connect() as c:
                c.execute('DELETE FROM claims WHERE article_id = %s', (aid,))
            return 0
        content = strip_images(a['content'])
        out = llm.ask([{'role': 'user', 'content': llm.fill('claims', title=a['title'], content=content)}], Claims, temperature=0)
        kept = [x for x in out.claims if x.program in PROGRAMS and x.rule_type in RULE_TYPES and verify_quotes([x.sentence], content)]
        with connect() as c:
            c.execute('DELETE FROM claims WHERE article_id = %s', (aid,))
            for x in kept:
                c.execute('INSERT INTO claims (article_id, sentence, program, rule_type) VALUES (%s,%s,%s,%s)',
                          (aid, x.sentence.strip(), x.program, x.rule_type))
        for k in {(x.program, x.rule_type) for x in kept}:
            judge(*k, article_id=aid)
        return len(kept)


def index_safe(aid):
    """发文／改文后背景跑：LLM 不可用或出错只印出来，文章照发（之后补跑 python -m app.freshness index）。"""
    try:
        index_article(aid)
    except Exception as e:  # noqa: BLE001  背景线程，不能让错误掉进无人处
        print(f'[保鲜度] 文章 {aid} 核验失败：{type(e).__name__}: {str(e)[:100]}')


# ---------- 07 #10：一条规则判断底下所有主张 ----------
class Judgment(BaseModel):
    id: int
    status: str
    reason: str = ''
    quote: str = ''

    @field_validator('status', mode='before')
    @classmethod
    def known(cls, v):
        return v if v in ('valid', 'changed', 'unknown') else 'unknown'


class Judgments(BaseModel):
    judgments: list[Judgment] = []


def judge(program, rule_type, article_id=None):
    """拿 (program, rule_type) 最新一年的规则，判断底下的主张（给 article_id 只判这篇的）。
    没有规则 → 全部 unknown；引用对不上最新通知 → unknown。"""
    with connect() as c:
        rule = c.execute('SELECT r.*, n.title, n.text FROM rules r JOIN notices n ON n.id = r.notice_id '
                         'WHERE r.program = %s AND r.rule_type = %s ORDER BY r.year DESC LIMIT 1', (program, rule_type)).fetchone()
        rows = c.execute('SELECT cl.id, cl.sentence, extract(year FROM a.date)::int AS year FROM claims cl '
                         'JOIN articles a ON a.id = cl.article_id WHERE cl.program = %s AND cl.rule_type = %s '
                         'AND (%s::text IS NULL OR cl.article_id = %s)', (program, rule_type, article_id, article_id)).fetchall()
        if not rows:
            return
        if not rule:
            c.execute("UPDATE claims SET status = 'unknown', reason = '光华通知里没有这类规则', quote = '', rule_id = NULL, "
                      'checked_at = now() WHERE id = ANY(%s)', ([r['id'] for r in rows],))
            return
    out = llm.ask([{'role': 'user', 'content': llm.fill(
        'fresh_judge', year=str(rule['year']), title=rule['title'], rule_type=rule_type, content=rule['content'],
        text=rule['text'], claims=[{'id': r['id'], 'sentence': r['sentence'], 'year': r['year']} for r in rows])}],
        Judgments, temperature=0)
    by_id = {j.id: j for j in out.judgments}
    with connect() as c:
        for r in rows:
            j = by_id.get(r['id']) or Judgment(id=r['id'], status='unknown', reason='没判断到')
            if j.status != 'unknown' and not verify_quotes([j.quote], rule['text']):
                j = Judgment(id=r['id'], status='unknown', reason='引用在通知里查不到')
            c.execute('UPDATE claims SET status = %s, reason = %s, quote = %s, rule_id = %s, checked_at = now() WHERE id = %s',
                      (j.status, j.reason[:200], j.quote if j.status != 'unknown' else '', rule['id'], r['id']))


def recheck(program=None):
    with connect() as c:
        keys = c.execute('SELECT DISTINCT program, rule_type FROM claims WHERE %s::text IS NULL OR program = %s',
                         (program, program)).fetchall()
    for k in keys:
        judge(k['program'], k['rule_type'])
    return len(keys)


def status_of(status, rule_year, today=None):
    """读的时候算 🟡：判「仍成立」但依据的通知早于今年（今年的还没发）→ pending。"""
    today = today or date.today()
    return 'pending' if status == 'valid' and rule_year and rule_year < today.year else status


def article_claims(c, aid, today=None):
    """文章页用：每条主张带状态、理由、官方原文、依据通知。"""
    rows = c.execute('SELECT cl.sentence, cl.status, cl.reason, cl.quote, cl.program, cl.rule_type, r.year, n.title AS "noticeTitle", '
                     'n.url AS "noticeUrl", cl.checked_at AS "checkedAt" FROM claims cl LEFT JOIN rules r ON r.id = cl.rule_id '
                     'LEFT JOIN notices n ON n.id = r.notice_id WHERE cl.article_id = %s ORDER BY cl.id', (aid,)).fetchall()
    return [{**r, 'status': status_of(r['status'], r['year'], today)} for r in rows]


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else ''), sys.argv[2:]
    if cmd == 'crawl':
        print(f'新通知 {len(crawl())} 份')
    elif cmd == 'index':
        if not args:
            with connect() as c:
                args = [r['id'] for r in c.execute("SELECT id FROM articles WHERE type = 'article' AND content LIKE %s",
                                                   (f'%{KEYWORD}%',)).fetchall()]
        for aid in args:
            print(f'  {aid}：{index_article(aid)} 条主张')
    elif cmd == 'recheck':
        print(f'重判 {recheck()} 条规则')
    else:
        sys.exit(__doc__)
