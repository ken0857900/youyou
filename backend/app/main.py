"""PathFinder 后端。回传字段名对齐 website/frontend/src/data/mock.js，前端换 API 只改取数据那一层。
身份：mock 登录后前端把 account id 放 X-Account-Id 头（真邮箱验证码之后做）。"""
import hashlib
import hmac
import html
import math
import os
import re
import secrets
import smtplib
import urllib.parse
from email.message import EmailMessage
from email.utils import formataddr
from datetime import datetime, timedelta
import uuid
from typing import Optional

import io
import json
import queue
from pathlib import Path
import threading
import time

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field
import psycopg
from psycopg.types.json import Jsonb

from . import agents as A
from . import freshness as F
from . import llm
from .db import connect, one, query

app = FastAPI(title='PathFinder')
UPLOADS = Path(__file__).resolve().parent.parent / 'uploads'
UPLOADS.mkdir(exist_ok=True)
app.mount('/uploads', StaticFiles(directory=UPLOADS), name='uploads')

# 固定 6 个分类＝决策类型，跟 mock.js CATEGORIES 一致（公司 10/16 移出参赛版，jobs 接口留着备用）
CATEGORIES = [
    {'id': 'baoyan', 'name': '保研', 'desc': '夏令营、预推免、联系导师'},
    {'id': 'kaoyan', 'name': '考研', 'desc': '择校、跨考、一战二战'},
    {'id': 'chuguo', 'name': '出国', 'desc': '申请、选校、放弃出国'},
    {'id': 'qiuzhi', 'name': '求职', 'desc': '秋招、春招、实习转正'},
    {'id': 'kaogong', 'name': '考公', 'desc': '国考、省考、选调生'},
    {'id': 'daoshi', 'name': '选导师', 'desc': '套磁、换组、读博'},
]

DP_COLS = ['决策类型', '学校层级', '专业', '成绩', '年级', '考虑过的选项', '最后的选择', '结果', '结果说明', '年份', '原话']
DP_JSON = 'json_build_object(' + ', '.join(f"'{c}', d.\"{c}\"" for c in DP_COLS) + ')'

# 文章：decisionPoint 取第一个（前端目前只显示一个）；decisionPoints 全部；views30d = 30 天不同点击人数
ARTICLE_SQL = f"""
SELECT a.id, a.author_id AS "authorId", to_char(a.date, 'YYYY-MM-DD') AS date, a.stars, a.bookmarks,
       a.views_seed + (SELECT count(DISTINCT viewer) FROM article_views v
                       WHERE v.article_id = a.id AND v.day > current_date - 30) AS "views30d",
       a.title, a.summary, a.content, a.tags, a.type, a.status, a.category,
       (SELECT {DP_JSON} FROM decision_points d WHERE d.article_id = a.id ORDER BY d.id LIMIT 1) AS "decisionPoint",
       (SELECT coalesce(json_agg({DP_JSON} ORDER BY d.id), '[]') FROM decision_points d WHERE d.article_id = a.id) AS "decisionPoints"
FROM articles a
"""


def read_time(text):
    return f'{max(3, math.ceil(len(text) / 300))} 分钟'


def articles(where='TRUE', params=(), tail=''):
    rows = query(f'{ARTICLE_SQL} WHERE {where} {tail}', params)
    for r in rows:
        r['readTime'] = read_time(r['content'])
    return rows


def account_of(x_account_id):
    """X-Account-Id 头放的是登录时发的 token → 账号 ID；没带／无效回 None。
    AUTH_ALLOW_ID=1（只给测试）时也认纯数字账号 ID。"""
    if not x_account_id:
        return None
    if os.getenv('AUTH_ALLOW_ID') == '1' and x_account_id.isdigit():
        return int(x_account_id)
    r = one('SELECT account_id FROM sessions WHERE token = %s', (x_account_id,))
    return r and r['account_id']


def need_account(x_account_id):
    acc = account_of(x_account_id)
    if not acc:
        raise HTTPException(401, '请先登录')
    return acc


# ---------- 基本 ----------
@app.get('/api/health')
def health():
    try:
        with connect() as c:
            c.execute('SELECT 1')
        return {'ok': True, 'db': 'up'}
    except Exception as e:  # 没装 Docker 时也能回
        return {'ok': True, 'db': 'down', 'error': str(e)[:200]}


@app.get('/api/categories')
def categories():
    return CATEGORIES


# ---------- 人物 ----------
PERSON_SQL = "SELECT profile || jsonb_build_object('id', id, 'name', name, 'schoolTier', school_tier, 'major', major) AS p FROM persons"


@app.get('/api/persons')
def persons():
    return [r['p'] for r in query(PERSON_SQL + ' ORDER BY id')]


@app.get('/api/persons/{pid}')
def person(pid: str):
    r = one(PERSON_SQL + ' WHERE id = %s', (pid,))
    if not r:
        raise HTTPException(404)
    return r['p']


class TimelineItem(BaseModel):
    year: str
    title: str
    desc: str = ''


class FaqItem(BaseModel):
    q: str
    a: str


class ProfileIn(BaseModel):  # 全部可选：只改传进来的
    name: Optional[str] = Field(None, pattern=r'\S')  # 空字串或全空白会被 coalesce 存成空名字，直接挡
    schoolTier: Optional[str] = None
    major: Optional[str] = None
    title: Optional[str] = None
    tagline: Optional[str] = None
    school: Optional[str] = None
    gradYear: Optional[str] = None
    city: Optional[str] = None
    timeline: Optional[list[TimelineItem]] = None
    faqs: Optional[list[FaqItem]] = None
    consultationAvailable: Optional[bool] = None
    price20m: Optional[int] = Field(None, ge=0)
    price40m: Optional[int] = Field(None, ge=0)
    avatar: Optional[str] = Field(None, pattern=r'^(/uploads/[\w.-]+|data:image/svg\+xml;.*)$')  # 只收自己上传的图或内建字母头像
    payQr: Optional[str] = Field(None, pattern=r'^(/uploads/[\w.-]+)?$')  # 微信收款码，只收自己上传的图；空字串 = 拿掉


@app.patch('/api/me/profile')
def update_profile(body: ProfileIn, x_account_id: Optional[str] = Header(None)):
    a = one('SELECT person_id FROM accounts WHERE id = %s', (need_account(x_account_id),))
    if not a or not a['person_id']:
        raise HTTPException(403, '只有分享者能改人物资料')
    d = body.model_dump(exclude_unset=True)
    cols = {k: d.pop(k) for k in ('name', 'schoolTier', 'major') if k in d}
    with connect() as c:
        c.execute('UPDATE persons SET name = coalesce(%s, name), school_tier = coalesce(%s, school_tier), '
                  'major = coalesce(%s, major), profile = profile || %s WHERE id = %s',
                  (cols.get('name'), cols.get('schoolTier'), cols.get('major'), Jsonb(d), a['person_id']))
    return person(a['person_id'])


# ---------- 上传图片 ----------
MAX_UPLOAD = 5 * 1024 * 1024


@app.post('/api/uploads')
def upload(file: UploadFile = File(...), purpose: str = Form('article'), x_account_id: Optional[str] = Header(None)):
    need_account(x_account_id)
    data = file.file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, '图片不能超过 5 MB')
    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format
        if fmt not in ('JPEG', 'PNG', 'WEBP'):
            raise ValueError
        img = ImageOps.exif_transpose(img)  # 先按 EXIF 转正，重新编码时不带任何 metadata
    except Exception:
        raise HTTPException(415, '只支持 jpg / png / webp 图片')
    if purpose == 'avatar':
        img = ImageOps.fit(img, (400, 400))
    else:
        img.thumbnail((1600, 1600))
    img = img.convert('RGB' if fmt == 'JPEG' or img.mode not in ('RGBA', 'LA') else 'RGBA')
    clean = Image.new(img.mode, img.size)  # 只拷像素：EXIF/GPS/ICC/文字块全丢
    clean.paste(img)
    ext = {'JPEG': 'jpg', 'PNG': 'png', 'WEBP': 'webp'}[fmt]
    name = f'{uuid.uuid4().hex}.{ext}'
    clean.save(UPLOADS / name, fmt, quality=88) if fmt != 'PNG' else clean.save(UPLOADS / name, fmt)
    return {'url': f'/uploads/{name}'}


# ---------- 文章 ----------
@app.get('/api/articles')
def list_articles(category: Optional[str] = None, type: Optional[str] = None, author: Optional[str] = None, lite: bool = False):
    rows = articles(
        '(%(c)s::text IS NULL OR a.category = %(c)s) AND (%(t)s::text IS NULL OR a.type = %(t)s)'
        ' AND (%(au)s::text IS NULL OR a.author_id = %(au)s)',
        {'c': category, 't': type, 'au': author}, 'ORDER BY a.date DESC')
    if lite:  # 前端启动整批拉：不带全文（占七成流量），进文章页再拉单篇
        for r in rows:
            r['content'] = None
    return rows


@app.get('/api/articles/{aid}')
def get_article(aid: str):
    rows = articles('a.id = %s', (aid,))
    if not rows:
        raise HTTPException(404)
    try:
        with connect() as c:  # 保鲜度（流程 D）只在单篇带，列表不带
            rows[0]['claims'] = F.article_claims(c, aid)
    except psycopg.errors.UndefinedTable:  # 保鲜度三张表还没建：文章照常显示
        rows[0]['claims'] = []
    return rows[0]


class ViewIn(BaseModel):
    viewer: Optional[str] = None  # 没登录：前端 cookie 里的随机 id


@app.post('/api/articles/{aid}/view')
def view(aid: str, body: ViewIn, x_account_id: Optional[str] = Header(None)):
    viewer = str(account_of(x_account_id) or '') or body.viewer or uuid.uuid4().hex
    with connect() as c:
        c.execute('INSERT INTO article_views (article_id, viewer) VALUES (%s, %s) ON CONFLICT DO NOTHING', (aid, viewer))
    return {'viewer': viewer}


@app.get('/api/trending')
def trending(type: str = 'article', limit: int = 5):
    return articles('a.type = %s', (type, limit), 'ORDER BY "views30d" DESC LIMIT %s')


class ArticleIn(BaseModel):  # 作者由后端按登录身份决定，前端传的 authorId 不收
    type: str = 'article'
    category: Optional[str] = None
    title: str
    summary: str = ''
    content: str
    tags: list[str] = []
    decisionPoints: Optional[list[dict]] = None  # 写作页让作者确认过的决策点（先叫 /api/articles/extract 预览）
    requestId: Optional[str] = None  # 从求经验邀请进来写的


class ExtractIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=50000)


@app.post('/api/articles/extract')
def extract_preview(e: ExtractIn, x_account_id: Optional[str] = Header(None)):
    """写作页按「发布」先叫这个：大模型从正文抽决策点给作者看、改，确认后才真的发布。
    要分享者身份（会花 LLM 钱）。LLM 不可用回一个「未提及」占位让作者自己填。"""
    me = my_sharer_person(x_account_id)
    try:
        return {'points': A.extract_decision_points(e.title, e.content, A.author_background(me)), 'source': 'llm'}
    except (llm.LLMUnavailable, ValueError):
        return {'points': [A.DecisionPoint().model_dump()], 'source': 'none'}


def my_sharer_person(x_account_id):
    """发文前检查：要登录、要验证过北大邮箱。回这个账号的人物 id（文章作者）。"""
    r = one('SELECT pku_verified, person_id FROM accounts WHERE id = %s', (need_account(x_account_id),))
    if not r or not r['pku_verified'] or not r['person_id']:
        raise HTTPException(403, '验证北大邮箱后才能发布')
    return r['person_id']


@app.post('/api/articles')
def publish(a: ArticleIn, x_account_id: Optional[str] = Header(None)):
    author = my_sharer_person(x_account_id)  # 不信前端传的 authorId，防冒名发文
    # 作者确认过的决策点优先（后端照样校验）；没传就调 DeepSeek 抽（07 #1），抽不到（没 key / 出错）放「未提及」占位
    points = A.confirmed_points(a.decisionPoints, a.content) if a.type == 'article' else []
    if a.type == 'article' and not points:
        try:
            points = A.extract_decision_points(a.title, a.content, A.author_background(author))
        except (llm.LLMUnavailable, ValueError):
            pass
        points = points or [A.DecisionPoint().model_dump()]
    category = (points[0]['决策类型'] if points and points[0]['决策类型'] != '未提及' else None) or a.category or '未提及'
    # 先抽完再一个交易写入（docs/03 流程 A）：API 中途失败不留半篇
    with connect() as c:
        aid = c.execute(
            'INSERT INTO articles (author_id, type, category, title, summary, content, tags) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id',
            (author, a.type, category, a.title, a.summary, a.content, a.tags)).fetchone()['id']
        if a.type == 'article':
            A.save_points(c, aid, points)
        if a.requestId:  # 求经验 ⑤：通知当初按「我想看」的读者（只有第一篇算）
            w = c.execute("UPDATE wish_requests SET status = '已有人写', article_id = %s WHERE id = %s AND article_id IS NULL RETURNING query",
                          (aid, a.requestId)).fetchone()
            if w:
                c.execute("INSERT INTO notifications (account_id, type, request_id, text, link) "
                          "SELECT account_id, 'written', wish_id, %s, %s FROM wish_readers WHERE wish_id = %s",
                          (f'你想看的「{w["query"]}」有人写了', f'/articles/{aid}', a.requestId))
        if a.type == 'article':
            A.rag_index(c, aid)
    threading.Thread(target=F.index_safe, args=(aid,), daemon=True).start()  # 保鲜度核验要几次 LLM，不拖慢发文
    return get_article(aid)


def own_article(aid, x_account_id):
    """作者本人才能改／删：登录账号的 person_id 要等于文章 author_id。回文章。"""
    acc = need_account(x_account_id)
    art = get_article(aid)
    me = one('SELECT person_id FROM accounts WHERE id = %s', (acc,))
    if not me or me['person_id'] != art['authorId']:
        raise HTTPException(403, '只能改自己的文章')
    return art


class ArticleEditIn(BaseModel):
    title: str = Field(min_length=1)
    content: str = Field(min_length=1)
    decisionPoints: Optional[list[dict]] = None  # 作者确认过的；没传就重抽


@app.put('/api/articles/{aid}')
def edit_article(aid: str, e: ArticleEditIn, x_account_id: Optional[str] = Header(None)):
    """作者改标题／正文。经验文章用作者确认过的决策点；没传就重抽（LLM 不可用留旧的）。同一交易重建 RAG 索引。"""
    art = own_article(aid, x_account_id)
    plain = A.strip_images(e.content)
    points = None
    if art['type'] == 'article':
        points = A.confirmed_points(e.decisionPoints, e.content) or None
        if not points:
            try:
                points = A.extract_decision_points(e.title, e.content, A.author_background(art['authorId'])) or None
            except (llm.LLMUnavailable, ValueError):
                pass
    with connect() as c:
        c.execute('UPDATE articles SET title = %s, content = %s, summary = %s WHERE id = %s',
                  (e.title.strip(), e.content.strip(), plain[:60] + ('…' if len(plain) > 60 else ''), aid))
        if points:
            A.save_points(c, aid, points)
            if points[0]['决策类型'] != '未提及':  # 同发文：抽不出类型就留原分类
                c.execute('UPDATE articles SET category = %s WHERE id = %s', (points[0]['决策类型'], aid))
        if art['type'] == 'article':
            A.rag_index(c, aid)  # 正文变了旧块会被排除，这里重建
    if e.content.strip() != (art['content'] or '').strip():  # 只改标题不重抽主张
        threading.Thread(target=F.index_safe, args=(aid,), daemon=True).start()
    return get_article(aid)


@app.delete('/api/articles/{aid}')
def delete_article(aid: str, x_account_id: Optional[str] = Header(None)):
    """作者删文：决策点、RAG 块、点击、星星、收藏、有帮到我都跟着删（外键 CASCADE）；
    这篇回应过的求经验单退回「等待中」。"""
    own_article(aid, x_account_id)
    with connect() as c:
        c.execute("UPDATE wish_requests SET article_id = NULL, status = '等待中' WHERE article_id = %s", (aid,))
        c.execute('DELETE FROM articles WHERE id = %s', (aid,))
    A.clear_caches()  # 缓存里的 agent 输出、推荐理由可能引用这篇
    return {'ok': True}


@app.post('/api/articles/{aid}/extract')
def re_extract(aid: str):
    """开发用：对已有文章重跑决策点抽取，覆盖原决策点。
    不验身份又会花 LLM 钱 → 平常关着（404），.env 设 DEV_EXTRACT=1 才开。"""
    if os.getenv('DEV_EXTRACT') != '1':
        raise HTTPException(404)
    art = get_article(aid)
    try:
        points = A.extract_decision_points(art['title'], art['content'], A.author_background(art['authorId']))
    except llm.LLMUnavailable as e:
        raise HTTPException(503, str(e))
    except ValueError:
        raise HTTPException(502, 'LLM 输出格式两次都不对')
    if not points:
        raise HTTPException(422, '没抽到决策点')
    with connect() as c:
        A.save_points(c, aid, points)
        if art['type'] == 'article' and points[0]['决策类型'] != '未提及':
            c.execute('UPDATE articles SET category = %s WHERE id = %s', (points[0]['决策类型'], aid))
            A.rag_index(c, aid)
    return {**get_article(aid), 'confidence': [p['confidence'] for p in points]}


def toggle(table, col, aid, acc):
    with connect() as c:
        gone = c.execute(f'DELETE FROM {table} WHERE article_id = %s AND account_id = %s', (aid, acc)).rowcount
        if not gone:
            c.execute(f'INSERT INTO {table} (article_id, account_id) VALUES (%s, %s)', (aid, acc))
        n = c.execute(f'UPDATE articles SET {col} = {col} + %s WHERE id = %s RETURNING {col}', (-1 if gone else 1, aid)).fetchone()
    return {'on': not gone, col: n[col] if n else 0}


@app.post('/api/articles/{aid}/star')
def star(aid: str, x_account_id: Optional[str] = Header(None)):
    return toggle('article_stars', 'stars', aid, need_account(x_account_id))


@app.post('/api/articles/{aid}/bookmark')
def bookmark(aid: str, x_account_id: Optional[str] = Header(None)):
    return toggle('bookmarks', 'bookmarks', aid, need_account(x_account_id))


# ---------- 我的 ----------
@app.get('/api/me/stars')
def my_stars(x_account_id: Optional[str] = Header(None)):
    return [r['article_id'] for r in query('SELECT article_id FROM article_stars WHERE account_id = %s', (need_account(x_account_id),))]


@app.get('/api/me/bookmarks')
def my_bookmarks(x_account_id: Optional[str] = Header(None)):
    return [r['article_id'] for r in query('SELECT article_id FROM bookmarks WHERE account_id = %s', (need_account(x_account_id),))]


@app.get('/api/me/helpful')
def my_helpful(x_account_id: Optional[str] = Header(None)):
    return [r['article_id'] for r in query('SELECT article_id FROM article_helpful WHERE account_id = %s ORDER BY created_at DESC', (need_account(x_account_id),))]


@app.get('/api/me/follows')
def my_follows(x_account_id: Optional[str] = Header(None)):
    return [r['person_id'] for r in query('SELECT person_id FROM follows WHERE account_id = %s', (need_account(x_account_id),))]


@app.post('/api/persons/{pid}/follow')
def follow(pid: str, x_account_id: Optional[str] = Header(None)):
    acc = need_account(x_account_id)
    with connect() as c:
        gone = c.execute('DELETE FROM follows WHERE account_id = %s AND person_id = %s', (acc, pid)).rowcount
        if not gone:
            c.execute('INSERT INTO follows (account_id, person_id) VALUES (%s, %s)', (acc, pid))
    return {'on': not gone}


# 回传形状对齐 BookingModal 的 addBooking：personId, mentorName, duration, slot, price, question
BOOKING_SQL = """SELECT b.id::text, b.person_id AS "personId", p.name AS "mentorName", b.minutes AS duration,
  b.slot, b.price, b.question, b.status, b.paid_at IS NOT NULL AS paid, nullif(p.profile->>'payQr', '') AS "payQr",
  (SELECT json_build_object('stars', r.stars, 'comment', r.comment) FROM booking_reviews r WHERE r.booking_id = b.id) AS review
  FROM bookings b JOIN persons p ON p.id = b.person_id"""


class BookingIn(BaseModel):
    personId: str
    minutes: int
    startsAt: datetime  # 从 /api/persons/{pid}/slots 挑的整点（北京时间）
    question: str = ''


# ---------- 可预约时段（以月为单位，北京时间整点） ----------
NOW_BJ = "(now() AT TIME ZONE 'Asia/Shanghai')"
WEEKDAY = '一二三四五六日'
SLOT_T = """to_char(a.starts_at, 'YYYY-MM-DD"T"HH24:MI')"""  # 回给前端的时段字串


def slot_text(t):
    return f"{t:%Y-%m-%d}（周{WEEKDAY[t.weekday()]}）{t:%H:%M}"


def month_range(month):
    try:
        start = datetime.strptime(month, '%Y-%m')
    except ValueError:
        raise HTTPException(422, 'month 格式要 YYYY-MM')
    return start, (start + timedelta(days=32)).replace(day=1)


@app.get('/api/persons/{pid}/slots')
def person_slots(pid: str, month: str):
    # 读者看的：这个月还没过、还没被约走的时段
    start, end = month_range(month)
    return [r['t'] for r in query(
        f"SELECT {SLOT_T} AS t FROM availability a WHERE a.person_id = %s "
        f"AND a.starts_at >= %s AND a.starts_at < %s AND a.starts_at > {NOW_BJ} "
        'AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.person_id = a.person_id AND b.starts_at = a.starts_at) '
        'ORDER BY a.starts_at', (pid, start, end))]


def my_person(x_account_id):
    a = one('SELECT person_id FROM accounts WHERE id = %s', (need_account(x_account_id),))
    if not a or not a['person_id']:
        raise HTTPException(403, '只有分享者能设定时段')
    return a['person_id']


@app.get('/api/me/availability')
def my_availability(month: str, x_account_id: Optional[str] = Header(None)):
    # 分享者自己看的：这个月勾过的全部时段＋哪些已被约
    pid, (start, end) = my_person(x_account_id), month_range(month)
    return query(f"SELECT {SLOT_T} AS t, "
                 'EXISTS (SELECT 1 FROM bookings b WHERE b.person_id = a.person_id AND b.starts_at = a.starts_at) AS booked '
                 'FROM availability a WHERE a.person_id = %s AND a.starts_at >= %s AND a.starts_at < %s ORDER BY 1', (pid, start, end))


class AssistIn(BaseModel):
    month: str
    text: str = Field(min_length=1, max_length=200)
    current: list[str] = []  # 月历上目前的时段（含还没存的）


@app.post('/api/me/availability/assist')
def availability_assist(body: AssistIn, x_account_id: Optional[str] = Header(None)):
    # 日历助手：只回预览，不写库；分享者在月历上看完按「确认储存」才走 PUT
    month_range(body.month)
    booked = {r['t'] for r in my_availability(body.month, x_account_id) if r['booked']}
    now = datetime.utcnow() + timedelta(hours=8)  # 北京时间（Windows 没装 tzdata，不用 zoneinfo）
    try:
        return A.calendar_assist(body.text.strip(), body.month, set(body.current) | booked, booked, now)
    except llm.LLMUnavailable as e:
        raise HTTPException(503, str(e))
    except ValueError:
        raise HTTPException(502, 'LLM 输出格式两次都不对')


class SlotAssistIn(BaseModel):
    month: str
    text: str = Field(min_length=1, max_length=200)


@app.post('/api/persons/{pid}/slots/assist')
def slots_assist(pid: str, body: SlotAssistIn, x_account_id: Optional[str] = Header(None)):
    # 读者说自己什么时候有空 → 日历助手展开成时段 → 跟这位分享者还能约的时段取交集
    need_account(x_account_id)
    open_ = person_slots(pid, body.month)  # 顺便验 month 格式
    try:
        r = A.calendar_assist(body.text.strip(), body.month, set(), set(), datetime.utcnow() + timedelta(hours=8))
    except llm.LLMUnavailable as e:
        raise HTTPException(503, str(e))
    except ValueError:
        raise HTTPException(502, 'LLM 输出格式两次都不对')
    free = set(r['slots'])
    return {'matches': [t for t in open_ if t in free], 'note': r['note'], 'ask': r['ask']}


class AvailabilityIn(BaseModel):
    month: str
    slots: list[datetime]


@app.put('/api/me/availability')
def set_availability(body: AvailabilityIn, x_account_id: Optional[str] = Header(None)):
    # 整个月覆盖：只动还没过的时段；已被约走的不能拿掉
    pid, (start, end) = my_person(x_account_id), month_range(body.month)
    want = {t.replace(minute=0, second=0, microsecond=0, tzinfo=None) for t in body.slots if start <= t.replace(tzinfo=None) < end}
    with connect() as c:
        c.execute(f'DELETE FROM availability a WHERE person_id = %s AND starts_at >= %s AND starts_at < %s AND starts_at > {NOW_BJ} '
                  'AND NOT (starts_at = ANY(%s)) '
                  'AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.person_id = a.person_id AND b.starts_at = a.starts_at)',
                  (pid, start, end, list(want)))
        for t in want:
            c.execute(f'INSERT INTO availability VALUES (%s, %s) ON CONFLICT DO NOTHING', (pid, t))
    return my_availability(body.month, x_account_id)


@app.post('/api/bookings')
def add_booking(b: BookingIn, x_account_id: Optional[str] = Header(None)):
    acc = need_account(x_account_id)
    if b.minutes not in (20, 40):
        raise HTTPException(422, 'minutes 只能 20 或 40')
    p = one('SELECT profile FROM persons WHERE id = %s', (b.personId,))
    if not p:
        raise HTTPException(404)
    price = p['profile'].get(f'price{b.minutes}m')  # 价格以库里为准，不信前端
    t = b.startsAt.replace(tzinfo=None)
    with connect() as c:
        ok = c.execute(f'SELECT 1 FROM availability WHERE person_id = %s AND starts_at = %s AND starts_at > {NOW_BJ}', (b.personId, t)).fetchone()
        if not ok:
            raise HTTPException(409, '这个时段不能约了，请换一个')
        # 唯一索引挡同一时段被约两次（两人同时按也只会成功一个）
        bid = c.execute('INSERT INTO bookings (person_id, account_id, minutes, price, slot, starts_at, question) VALUES (%s,%s,%s,%s,%s,%s,%s) '
                        'ON CONFLICT (person_id, starts_at) DO NOTHING RETURNING id',
                        (b.personId, acc, b.minutes, price, slot_text(t), t, b.question)).fetchone()
        if not bid:
            raise HTTPException(409, '这个时段刚被别人约走了，请换一个')
        bid = bid['id']
    return one(BOOKING_SQL + ' WHERE b.id = %s', (bid,))


@app.get('/api/me/bookings')
def my_bookings(x_account_id: Optional[str] = Header(None)):
    return query(BOOKING_SQL + ' WHERE b.account_id = %s ORDER BY b.created_at DESC', (need_account(x_account_id),))


@app.get('/api/me/incoming-bookings')
def incoming_bookings(x_account_id: Optional[str] = Header(None)):
    # 分享者看「别人约我的」：只给读者显示名，不给邮箱
    me = one('SELECT person_id FROM accounts WHERE id = %s', (need_account(x_account_id),))
    if not me or not me['person_id']:
        return []
    return query('SELECT b.id::text, a.name AS "readerName", b.minutes AS duration, b.slot, b.price, b.question, b.status, '
                 "b.paid_at IS NOT NULL AS paid, to_char(b.created_at, 'YYYY-MM-DD') AS date "
                 'FROM bookings b JOIN accounts a ON a.id = b.account_id WHERE b.person_id = %s '
                 'ORDER BY b.starts_at DESC NULLS LAST, b.created_at DESC', (me['person_id'],))


@app.post('/api/bookings/{bid}/paid')
def mark_paid(bid: int, x_account_id: Optional[str] = Header(None)):
    # 读者扫分享者的收款码付完按一下；只记录、通知分享者去微信核对，平台不经手钱
    acc = need_account(x_account_id)
    with connect() as c:
        b = c.execute('SELECT b.account_id, b.person_id, b.minutes, b.price, b.slot, a.name FROM bookings b '
                      'JOIN accounts a ON a.id = b.account_id WHERE b.id = %s', (bid,)).fetchone()
        if not b or b['account_id'] != acc:
            raise HTTPException(403, '只能标记自己的预约')
        if c.execute('UPDATE bookings SET paid_at = now() WHERE id = %s AND paid_at IS NULL', (bid,)).rowcount:
            c.execute("INSERT INTO notifications (person_id, type, text, link) VALUES (%s, 'paid', %s, '/me')",
                      (b['person_id'], f'{b["name"]} 已标记付款：{b["minutes"]} 分钟咨询 ¥{b["price"]}（{b["slot"]}），请到微信核对'))
    return one(BOOKING_SQL + ' WHERE b.id = %s', (bid,))


class ReviewIn(BaseModel):
    stars: int = Field(ge=1, le=5)
    comment: str = Field('', max_length=500)


@app.post('/api/bookings/{bid}/complete-review')
def complete_review(bid: int, body: ReviewIn, x_account_id: Optional[str] = Header(None)):
    acc = need_account(x_account_id)
    with connect() as c:
        b = c.execute('SELECT person_id, account_id FROM bookings WHERE id = %s', (bid,)).fetchone()
        if not b or b['account_id'] != acc:
            raise HTTPException(403, '只能评价自己的预约')
        ok = c.execute('INSERT INTO booking_reviews (booking_id, account_id, person_id, stars, comment) VALUES (%s,%s,%s,%s,%s) '
                       'ON CONFLICT DO NOTHING', (bid, acc, b['person_id'], body.stars, body.comment.strip())).rowcount
        if not ok:
            raise HTTPException(409, '这笔预约已经评价过了')
        c.execute("UPDATE bookings SET status = 'done' WHERE id = %s", (bid,))
    return one(BOOKING_SQL + ' WHERE b.id = %s', (bid,))


# ---------- 评价：评的是「有没有帮到我」，不是评人 ----------
class HelpfulIn(BaseModel):
    comment: str = Field('', max_length=200)


@app.get('/api/articles/{aid}/helpful')
def helpful(aid: str, x_account_id: Optional[str] = Header(None)):
    rows = query("SELECT h.account_id, ac.name, h.comment, to_char(h.created_at, 'YYYY-MM-DD') AS date FROM article_helpful h "
                 'JOIN accounts ac ON ac.id = h.account_id WHERE h.article_id = %s ORDER BY h.created_at DESC', (aid,))
    me = account_of(x_account_id)
    return {'count': len(rows), 'mine': any(r['account_id'] == me for r in rows),
            'comments': [{k: r[k] for k in ('name', 'comment', 'date')} for r in rows if r['comment']]}


@app.post('/api/articles/{aid}/helpful')
def mark_helpful(aid: str, body: HelpfulIn, x_account_id: Optional[str] = Header(None)):
    """upsert：再按一次只更新短评，不重复计数；取消用 DELETE。"""
    acc = need_account(x_account_id)
    with connect() as c:
        c.execute('INSERT INTO article_helpful (article_id, account_id, comment) VALUES (%s,%s,%s) '
                  'ON CONFLICT (article_id, account_id) DO UPDATE SET comment = EXCLUDED.comment', (aid, acc, body.comment.strip()))
    return helpful(aid, x_account_id)


@app.delete('/api/articles/{aid}/helpful')
def unmark_helpful(aid: str, x_account_id: Optional[str] = Header(None)):
    with connect() as c:
        c.execute('DELETE FROM article_helpful WHERE article_id = %s AND account_id = %s', (aid, need_account(x_account_id)))
    return helpful(aid, x_account_id)


HELPED_SQL = '(SELECT count(DISTINCT h.account_id) FROM article_helpful h JOIN articles a ON a.id = h.article_id WHERE a.author_id = p.id)'


@app.get('/api/persons/{pid}/stats')
def person_stats(pid: str):
    r = one(f'SELECT {HELPED_SQL} AS "helpedCount", (SELECT round(avg(stars), 1)::float FROM booking_reviews WHERE person_id = p.id) AS "ratingAvg", '
            '(SELECT count(*) FROM booking_reviews WHERE person_id = p.id) AS "ratingCount" FROM persons p WHERE p.id = %s', (pid,))
    if not r:
        raise HTTPException(404)
    r['recentReviews'] = query("SELECT ac.name, r.stars, r.comment, to_char(r.created_at, 'YYYY-MM-DD') AS date FROM booking_reviews r "
                               'JOIN accounts ac ON ac.id = r.account_id WHERE r.person_id = %s ORDER BY r.created_at DESC LIMIT 5', (pid,))
    return r


@app.get('/api/leaderboard/helpful')
def leaderboard(limit: int = 5):
    return query(f'SELECT * FROM (SELECT p.id, p.name, {HELPED_SQL} AS "helpedCount" FROM persons p) t '
                 'WHERE "helpedCount" > 0 ORDER BY "helpedCount" DESC, id LIMIT %s', (limit,))


# ---------- 职位 ----------
JOB_SQL = """SELECT id, company, official, title, city, salary, majors, decision_types AS "decisionTypes",
  to_char(date, 'YYYY-MM-DD') AS date, to_char(deadline, 'YYYY-MM-DD') AS deadline, description FROM jobs"""


@app.get('/api/hero')
def hero():
    return query("SELECT image_url AS url, caption, season, title, alt, credit FROM hero_slides WHERE active ORDER BY sort_order, id")


@app.get('/api/site-images')
def site_images():
    return query("SELECT key, image_url AS url, alt FROM site_images")


@app.get('/api/jobs')
def jobs():
    return query(JOB_SQL + ' ORDER BY date DESC')


@app.get('/api/jobs/{jid}')
def job(jid: str):
    r = one(JOB_SQL + ' WHERE id = %s', (jid,))
    if not r:
        raise HTTPException(404)
    return r


class JobIn(BaseModel):
    title: str
    city: str = ''
    salary: str = ''
    majors: list[str] = []
    decisionTypes: list[str] = []
    deadline: Optional[str] = None
    description: str = ''


def need_company(x_account_id):
    r = one('SELECT c.id, c.name, c.approved FROM accounts a JOIN companies c ON c.id = a.company_id '
            "WHERE a.id = %s AND a.role = 'company'", (need_account(x_account_id),))
    if not r or not r['approved']:
        raise HTTPException(403, '仅限审核通过的公司账号')
    return r


@app.post('/api/jobs')
def add_job(j: JobIn, x_account_id: Optional[str] = Header(None)):
    co = need_company(x_account_id)
    with connect() as c:
        jid = c.execute('INSERT INTO jobs (company_id, company, official, title, city, salary, majors, decision_types, deadline, description) '
                        'VALUES (%s,%s,true,%s,%s,%s,%s,%s,%s,%s) RETURNING id',
                        (co['id'], co['name'], j.title, j.city, j.salary, j.majors, j.decisionTypes, j.deadline or None, j.description)).fetchone()['id']
    return job(jid)


@app.get('/api/me/jobs')
def my_jobs(x_account_id: Optional[str] = Header(None)):
    return query(JOB_SQL + ' WHERE company_id = %s ORDER BY date DESC, id DESC', (need_company(x_account_id)['id'],))


# ---------- 搜索 ----------
def search_records():
    rows = articles("a.type = 'article' AND EXISTS (SELECT 1 FROM decision_points d WHERE d.article_id = a.id)")
    for r in rows:  # 图片标记不进关键词比对和 agent
        r['content'] = A.strip_images(r['content'])
    return rows


# ---------- 会花大模型钱的开放接口：按 IP 限流（搜索、AI 帮我选不用登录，评审要能直接试） ----------
# ponytail: 进程内滑动窗口，重启归零、多 worker 不共享；要更严改 nginx limit_req 或 Redis
HITS = {}  # (桶, IP) -> 最近 60 秒的请求时间


def rate_limit(request, bucket, per_min):
    host = request.client.host if request.client else ''
    ip = request.headers.get('x-real-ip', host) if host == '127.0.0.1' else host  # 只信本机 nginx 转来的 X-Real-IP
    now = time.time()
    hits = [t for t in HITS.get((bucket, ip), []) if now - t < 60]
    if len(hits) >= per_min:
        raise HTTPException(429, '操作太频繁，请一分钟后再试')
    HITS[(bucket, ip)] = hits + [now]


SEARCH_PER_MIN = int(os.getenv('SEARCH_PER_MIN', '20'))
PARSE_PER_MIN = int(os.getenv('PARSE_PER_MIN', '10'))


@app.get('/api/search/stream')
def search_stream(request: Request, q: str = Query('', max_length=200), viewer: Optional[str] = None, x_account_id: Optional[str] = Header(None)):
    """SSE：result（①–④ 处境抽取＋召回＋分群，未经判断 agent）→ step / group / review 陆续推 → done（或 error）。"""
    rate_limit(request, 'search', SEARCH_PER_MIN)
    records, box = search_records(), queue.Queue()

    def work():
        try:
            A.run_search(q, records, str(account_of(x_account_id) or '') or viewer, emit=lambda kind, data: box.put((kind, data)))
        except Exception as e:
            box.put(('error', {'error': str(e)[:200]}))

    threading.Thread(target=work, daemon=True).start()

    def gen():
        while True:
            kind, data = box.get()
            yield f'event: {kind}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n'
            if kind in ('done', 'error'):
                return

    return StreamingResponse(gen(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache'})



@app.get('/api/filters/parse')
def parse_filters(request: Request, q: str = Query('', max_length=200)):
    """主题／热门／人物页「AI 帮我选」：一句话 → LLM 抽 决策类型／学校层级／专业／结果（07 #2），
    再用这些条件走 RAG（向量＋全文＋rerank）召回，results＝按匹配先后排的文章 id。
    LLM 不可用退回关键词。LLM 抽取结果按句子缓存；召回每次重跑（新文章马上搜得到）。"""
    key = re.sub(r'\s+', '', q.lower())
    if key not in PARSE_CACHE:
        rate_limit(request, 'parse', PARSE_PER_MIN)
        parsed, how = A.parse_situation(q, [], use_llm=True)
        if how != 'llm':  # LLM 失败退回的关键词版不缓存，下次再试 LLM
            return parse_out(q, parsed, how)
        if len(PARSE_CACHE) > 1000:  # ponytail: 满了整个清空，够用；要 LRU 再换
            PARSE_CACHE.clear()
        PARSE_CACHE[key] = (parsed, how)
    return parse_out(q, *PARSE_CACHE[key])


def parse_out(q, parsed, how):
    rq = parsed.get('query') or q  # LLM 改正错字后的检索句
    results = [] if parsed['irrelevant'] else [a['id'] for a in A.rag_recall(rq, search_records(), parsed)[0]]
    keep = ['决策类型', '学校层级', '专业', '结果']
    return {'filters': {k: parsed['filters'].get(k, []) for k in keep}, 'irrelevant': parsed['irrelevant'],
            'results': results, 'query': parsed.get('query'), 'source': how}


PARSE_CACHE = {}


@app.get('/api/filters/why')
def filters_why(request: Request, q: str = Query('', max_length=200)):
    """「AI 帮我选」第二步：给召回的文章（最多 30 篇）写「为什么是他／独有的点／原话」（07 #11）。
    另一个请求，筛选先出来、理由后到；跟 parse 共用 LLM 抽取缓存，理由按句子缓存。LLM 不可用回空的。"""
    key = re.sub(r'\s+', '', q.lower())
    if key in WHY_CACHE:
        return {'why': WHY_CACHE[key]}
    if not q.strip() or not llm.available():
        return {'why': {}}
    rate_limit(request, 'why', PARSE_PER_MIN)
    parsed, how = PARSE_CACHE.get(key) or A.parse_situation(q, [], use_llm=True)
    if parsed['irrelevant']:
        return {'why': {}}
    arts = A.rag_recall(parsed.get('query') or q, search_records(), parsed)[0]
    try:
        why = A.list_why(q, parsed['situation'], arts)
    except (llm.LLMUnavailable, ValueError):
        return {'why': {}}
    if how == 'llm':  # 关键词退路时的理由不缓存，下次再试 LLM
        if len(WHY_CACHE) > 1000:  # ponytail: 同 PARSE_CACHE，满了整个清空
            WHY_CACHE.clear()
        WHY_CACHE[key] = why
    return {'why': why}


WHY_CACHE = A.WHY_CACHE  # 文章发布／改／删时 A.clear_caches() 一起清

# ---------- 求经验 / 通知 ----------
WISH_SQL = 'SELECT id, query, conditions, want_count AS "wantCount", status, article_id AS "articleId" FROM wish_requests'


@app.get('/api/wishes')
def wishes():
    return query(WISH_SQL + ' ORDER BY created_at')


@app.get('/api/wishes/{wid}')
def wish(wid: str):
    r = one(WISH_SQL + ' WHERE id = %s', (wid,))
    if not r:
        raise HTTPException(404)
    return r


class WishIn(BaseModel):
    query: str
    conditions: dict = {}


@app.post('/api/wishes')
def add_wish(w: WishIn, x_account_id: Optional[str] = Header(None)):
    # 同一搜索字合并；同一读者按几次都只算一次。人数刚好到 WISH_NOTIFY_AT 那一下邀请分享者（只发一次）
    me = need_account(x_account_id)
    with connect() as c:
        wid = c.execute('INSERT INTO wish_requests (query, conditions, want_count) VALUES (%s, %s, 0) '
                        'ON CONFLICT (query) DO UPDATE SET query = EXCLUDED.query RETURNING id',
                        (w.query, Jsonb(w.conditions))).fetchone()['id']
        if c.execute('INSERT INTO wish_readers VALUES (%s, %s) ON CONFLICT DO NOTHING', (wid, me)).rowcount:
            r = c.execute('UPDATE wish_requests SET want_count = want_count + 1 WHERE id = %s RETURNING want_count, conditions', (wid,)).fetchone()
            if r['want_count'] == A.WISH_NOTIFY_AT:
                # ponytail: 规则挑不到时 agent 在交易里同步跑（最多 LLM_TIMEOUT 秒）；人多了改成背景任务
                picks, _ = A.pick_sharers(c, w.query, r['conditions'])
                for pid in picks:
                    c.execute("INSERT INTO notifications (person_id, type, request_id, text, link) VALUES (%s, 'invited', %s, %s, %s)",
                              (pid, wid, f'有 {r["want_count"]} 位读者想知道：{w.query}', f'/write?request={wid}'))
    return wish(wid)


# 发给这个账号的，加上发给「这个账号对应的分享者」的
MINE = '(account_id = %(me)s OR person_id = (SELECT person_id FROM accounts WHERE id = %(me)s))'


@app.get('/api/notifications')
def notifications(x_account_id: Optional[str] = Header(None)):
    return query('SELECT id::text, type, request_id AS "requestId", text, link, to_char(date, \'YYYY-MM-DD\') AS date, read '
                 'FROM notifications WHERE ' + MINE + ' ORDER BY date DESC, id DESC', {'me': need_account(x_account_id)})


@app.post('/api/notifications/{nid}/read')
def read_notification(nid: int, x_account_id: Optional[str] = Header(None)):
    with connect() as c:
        c.execute('UPDATE notifications SET read = true WHERE id = %(nid)s AND ' + MINE, {'nid': nid, 'me': need_account(x_account_id)})
    return {'ok': True}


# ---------- 登录（假） ----------
class LoginIn(BaseModel):
    role: str


ACCOUNT_SQL = ('SELECT a.id, a.role, a.name, a.email, a.pku_verified AS "pkuVerified", a.person_id AS "personId", '
               'c.approved FROM accounts a LEFT JOIN companies c ON c.id = a.company_id')


def session_for(acc_id):
    token = secrets.token_urlsafe(32)
    with connect() as c:
        c.execute('INSERT INTO sessions (token, account_id) VALUES (%s, %s)', (token, acc_id))
    return {**one(ACCOUNT_SQL + ' WHERE a.id = %s', (acc_id,)), 'token': token}


@app.post('/api/login')
def login(body: LoginIn):
    # 演示模式：按身份登录第一个示例账号（评审不用注册也能试）；真用户走 /api/auth/*
    r = one(ACCOUNT_SQL + ' WHERE a.role = %s ORDER BY a.id LIMIT 1', (body.role,))
    if not r:
        raise HTTPException(404, '没有这个身份的账号，先跑 seed.py')
    return session_for(r['id'])


# ---------- 邮箱验证码：注册／登录、北大邮箱升级分享者 ----------
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
PKU_DOMAINS = ('@pku.edu.cn', '@stu.pku.edu.cn')  # 教职工／学生邮箱都算
CODE_TTL_MIN, RESEND_SEC, MAX_TRIES = 10, 60, 5


class SendCodeIn(BaseModel):
    email: str = Field(max_length=120)
    purpose: str = 'register'  # register / pku_verify


class VerifyIn(BaseModel):
    email: str = Field(max_length=120)
    code: str = Field(max_length=10)
    password: Optional[str] = Field(None, max_length=128)  # 注册／忘记密码时设的新密码


class PasswordLoginIn(BaseModel):
    email: str = Field(max_length=120)
    password: str = Field(max_length=128)


def hash_password(pw):
    salt = secrets.token_bytes(16)
    return f"scrypt${salt.hex()}${hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1).hex()}"


def check_password(pw, stored):
    if not stored:
        return False
    _, salt, h = stored.split('$')
    return hmac.compare_digest(hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1).hex(), h)


# ponytail: 进程内计数，重启归零、多 worker 不共享；要更严再放库里
LOGIN_FAILS = {}  # email -> (连续失败次数, 最后一次失败时间)
LOGIN_MAX_FAILS, LOGIN_LOCK_SEC = 5, 15 * 60


def letter_avatar(name):
    # 跟前端示例头像同一种：一个字的 SVG（不连外网）
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0d9488"/>'
           '<text x="32" y="42" font-family="system-ui,sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">'
           f'{html.escape(name[:1] or "?")}</text></svg>')
    return 'data:image/svg+xml;utf8,' + urllib.parse.quote(svg)


def code_hash(email, code):
    return hashlib.sha256(f'{email}:{code}'.encode()).hexdigest()


def send_mail(to, subject, body):
    msg = EmailMessage()
    msg['Subject'], msg['From'], msg['To'] = subject, formataddr(('鹿鸣 LUMING', os.getenv('SMTP_USER'))), to
    msg.set_content(body)
    try:
        with smtplib.SMTP_SSL(os.getenv('SMTP_HOST'), int(os.getenv('SMTP_PORT') or 465), timeout=15) as s:
            s.login(os.getenv('SMTP_USER'), os.getenv('SMTP_PASSWORD'))
            s.send_message(msg)
    except (smtplib.SMTPException, OSError):
        raise HTTPException(502, '验证码寄送失败，请稍后再试')


@app.post('/api/auth/send-code')
def send_code(body: SendCodeIn, x_account_id: Optional[str] = Header(None)):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, '邮箱格式不对')
    if body.purpose == 'pku_verify':
        acc = need_account(x_account_id)
        if not email.endswith(PKU_DOMAINS):
            raise HTTPException(422, '要用 @pku.edu.cn 或 @stu.pku.edu.cn 结尾的北大邮箱')
        if one('SELECT 1 FROM accounts WHERE pku_email = %s AND id <> %s', (email, acc)):
            raise HTTPException(409, '这个北大邮箱已经被别的账号验证过了')
    elif body.purpose != 'register':
        raise HTTPException(422, 'purpose 不对')
    if one("SELECT 1 FROM email_codes WHERE email = %s AND created_at > now() - make_interval(secs => %s)", (email, RESEND_SEC)):
        raise HTTPException(429, f'{RESEND_SEC} 秒内只能寄一次，请稍后再试')
    code = f'{secrets.randbelow(10 ** 6):06d}'
    with connect() as c:
        c.execute('UPDATE email_codes SET used = true WHERE email = %s AND purpose = %s AND NOT used', (email, body.purpose))
        c.execute('INSERT INTO email_codes (email, code, purpose, expires_at) VALUES (%s, %s, %s, now() + make_interval(mins => %s))',
                  (email, code_hash(email, code), body.purpose, CODE_TTL_MIN))
    what = '升级为分享者' if body.purpose == 'pku_verify' else '登录 / 注册'
    send_mail(email, f'鹿鸣验证码 {code}',
              f'你的鹿鸣{what}验证码是：{code}\n\n{CODE_TTL_MIN} 分钟内有效，只能用一次。不是你本人操作请忽略这封信。')
    return {'ok': True, 'resendAfter': RESEND_SEC}


def use_code(email, code, purpose):
    """验对就作废这个码；错了累计次数，满 MAX_TRIES 次作废。"""
    with connect() as c:
        r = c.execute('SELECT ctid, code, attempts FROM email_codes WHERE email = %s AND purpose = %s AND NOT used AND expires_at > now() '
                      'ORDER BY created_at DESC LIMIT 1', (email, purpose)).fetchone()
        if not r:
            raise HTTPException(400, '验证码已过期或已用过，请重新获取')
        if not hmac.compare_digest(r['code'], code_hash(email, code.strip())):
            c.execute('UPDATE email_codes SET attempts = attempts + 1, used = attempts + 1 >= %s WHERE ctid = %s', (MAX_TRIES, r['ctid']))
            raise HTTPException(400, '验证码不对' if r['attempts'] + 1 < MAX_TRIES else '输错太多次，请重新获取验证码')
        c.execute('UPDATE email_codes SET used = true WHERE ctid = %s', (r['ctid'],))


@app.post('/api/auth/verify')
def verify_login(body: VerifyIn):
    # 注册／忘记密码：验证码对了就设密码并登录，没账号就自动注册成读者；之后用 /api/auth/password-login
    email = body.email.strip().lower()
    if not body.password or len(body.password) < 8:
        raise HTTPException(422, '密码至少 8 位')
    use_code(email, body.code, 'register')
    with connect() as c:
        c.execute("INSERT INTO accounts (role, name, email) VALUES ('reader', %s, %s) ON CONFLICT (email) DO NOTHING",
                  (email.split('@')[0][:30], email))
        c.execute('UPDATE accounts SET password_hash = %s WHERE email = %s', (hash_password(body.password), email))
    LOGIN_FAILS.pop(email, None)
    acc = one('SELECT id, pku_verified FROM accounts WHERE email = %s', (email,))
    # 用北大邮箱登录＝已经证明是北大的，直接升级分享者，不用再验一次；
    # 这个北大邮箱已经被别的账号拿去升级过就不动（一个北大邮箱只升级一个账号）
    taken = one('SELECT 1 FROM accounts WHERE pku_email = %s AND id <> %s', (email, acc['id']))
    if email.endswith(PKU_DOMAINS) and not acc['pku_verified'] and not taken:
        upgrade_sharer(acc['id'], email)
    return session_for(acc['id'])


@app.post('/api/auth/password-login')
def password_login(body: PasswordLoginIn):
    email = body.email.strip().lower()
    n, last = LOGIN_FAILS.get(email, (0, 0))
    if n >= LOGIN_MAX_FAILS and time.time() - last < LOGIN_LOCK_SEC:
        raise HTTPException(429, '密码错太多次，15 分钟后再试，或用验证码重设密码')
    acc = one('SELECT id, password_hash FROM accounts WHERE email = %s', (email,))
    if not acc or not check_password(body.password, acc['password_hash']):
        LOGIN_FAILS[email] = (n + 1 if n < LOGIN_MAX_FAILS else 1, time.time())
        if acc and not acc['password_hash']:
            raise HTTPException(400, '这个账号还没设密码，请用验证码设一次')
        raise HTTPException(400, '邮箱或密码不对')
    LOGIN_FAILS.pop(email, None)
    return session_for(acc['id'])


def upgrade_sharer(acc, email):
    """升级成分享者：记下北大邮箱，没人物页就建一个空白的 u{账号id}。"""
    a = one('SELECT name, person_id FROM accounts WHERE id = %s', (acc,))
    pid = a['person_id'] or f'u{acc}'
    with connect() as c:
        if not a['person_id']:
            c.execute("INSERT INTO persons (id, name, profile) VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING",
                      (pid, a['name'], Jsonb({'school': '北京大学', 'avatar': letter_avatar(a['name']), 'tags': [], 'timeline': [], 'faqs': []})))
        c.execute("UPDATE accounts SET role = 'sharer', pku_verified = true, pku_email = %s, person_id = %s WHERE id = %s", (email, pid, acc))


@app.post('/api/auth/pku-verify')
def verify_pku(body: VerifyIn, x_account_id: Optional[str] = Header(None)):
    # 北大邮箱验证码对了 → 升级成分享者，建一个空白人物页
    acc = need_account(x_account_id)
    email = body.email.strip().lower()
    use_code(email, body.code, 'pku_verify')
    upgrade_sharer(acc, email)
    r = one(ACCOUNT_SQL + ' WHERE a.id = %s', (acc,))
    return {**r, 'token': x_account_id}


@app.post('/api/logout')
def logout(x_account_id: Optional[str] = Header(None)):
    if x_account_id:
        with connect() as c:
            c.execute('DELETE FROM sessions WHERE token = %s', (x_account_id,))
    return {'ok': True}
