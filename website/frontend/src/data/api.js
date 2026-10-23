// 取数据只走这里。后端（/api → :8000）连不上或 db down 时退回 mock.js，页面不用管来源。
// ponytail: 启动时把人物/文章/职位/求经验单整批拉下来灌进 mock 数组，页面照旧同步读 getArticle 等；
// 几百篇内够用，资料多到要分页时再改成各页 useEffect 按需取。
import { ACCOUNTS, ARTICLES, DP_FIELDS, HELPFUL, HERO_SLIDES, NOTIFICATIONS, PERSONS, REVIEWS, SITE_IMAGES, WISH_REQUESTS, addArticle } from './mock';
import { addWish, parseQuery } from './mockSearch';

export let source = 'mock'; // 'db' | 'mock'，页脚小标显示
let token = null; // 登录后后端发的凭证，每次请求带在 X-Account-Id 头
const SESSION = 'pf-session';
let onExpired = () => {}; // AppState 注册：凭证失效（账号被删、session 没了）时清掉登录状态
export const setOnExpired = (fn) => { onExpired = fn; };
const forget = () => { token = null; try { localStorage.removeItem(SESSION); } catch { /* 无痕模式 */ } };

async function req(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Account-Id': token } : {}) };
  const r = await fetch(path, { ...opts, headers, body: opts.body && JSON.stringify(opts.body) });
  if (r.status === 401 && token) { forget(); onExpired(); } // 存着旧凭证 → 当成没登录，不然画面以为登录了、写入全被挡
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).detail; } catch { /* 不是 JSON */ }
    throw new Error(typeof detail === 'string' && detail ? detail : `${path} ${r.status}`);
  }
  return r.json();
}

// 有库就打 API；没库、断线、5xx/4xx 都退回 fallback()
async function call(path, opts, fallback) {
  if (source === 'db') {
    try { return await req(path, opts); } catch (e) { console.warn('API 失败，用本地示例', e); }
  }
  return fallback();
}

// 写入：有库时失败要抛（带后端中文原因），不能退回本地假装成功；没库才用 fallback
const write = (path, opts, fallback) => (source === 'db' ? req(path, opts) : Promise.resolve(fallback()));

const fill = (arr, rows) => arr.splice(0, arr.length, ...rows);

export async function boot() {
  try {
    // health 跟资料同时发（不再先等 health 才拉）；库没起时 health 最多等 6 秒（网路慢也别太快放弃），之后用后备资料
    const all = Promise.all(['/api/persons', '/api/articles?lite=1', '/api/wishes', '/api/hero', '/api/site-images'].map((u) => req(u)));
    all.catch(() => {}); // health 先失败时，这边的错误不要变成未处理
    if ((await req('/api/health', { signal: AbortSignal.timeout(6000) })).db === 'up') {
      const [p, a, w, h, si] = await all;
      fill(PERSONS, p); fill(ARTICLES, a); fill(WISH_REQUESTS, w);
      if (h.length) fill(HERO_SLIDES, h); // 表空了就留内建图，首页不空白
      for (const r of si) SITE_IMAGES[r.key] = r; // 表里没有的 key 留内建图
      source = 'db';
      return;
    }
  } catch { /* 后端没开 */ }
  // 正式站连不上后端：读线上资料的快照（scripts/snapshot-fallback.mjs 产生，参赛版只有光华），不退回开发用的 mock.js
  if (import.meta.env.PROD && import.meta.env.MODE !== 'single') {
    try {
      const s = await req('/fallback.json');
      fill(PERSONS, s.persons); fill(ARTICLES, s.articles); fill(WISH_REQUESTS, s.wishes);
    } catch { /* 快照也拿不到：用 mock */ }
  }
}

// 登录状态记在 localStorage，重新整理不用再登录（读不到就当没登录）
function keep(acc) {
  token = acc.token ?? null;
  try { if (token) localStorage.setItem(SESSION, JSON.stringify(acc)); } catch { /* 无痕模式 */ }
  return acc;
}
export function restore() {
  try {
    const acc = JSON.parse(localStorage.getItem(SESSION));
    if (acc?.token) { token = acc.token; return acc; }
  } catch { /* 没有或坏了 */ }
  return null;
}

// 演示模式：选身份直接登录示例账号
export const login = async (role) => keep(await call('/api/login', { method: 'POST', body: { role } }, () => ACCOUNTS[role]));
export function logout() {
  if (token && source === 'db') req('/api/logout', { method: 'POST' }).catch(() => {});
  forget();
}

// 邮箱验证码：出错直接抛（带后端的中文原因），不退回 mock
const needDb = () => { if (source !== 'db') throw new Error('后端没连上，请先用下面的演示模式'); };
export const sendCode = (email, purpose = 'register') => { needDb(); return req('/api/auth/send-code', { method: 'POST', body: { email, purpose } }); };
// 注册／忘记密码：验证码＋设密码；之后用密码登录
export const verifyCode = async (email, code, password) => { needDb(); return keep(await req('/api/auth/verify', { method: 'POST', body: { email, code, password } })); };
export const passwordLogin = async (email, password) => { needDb(); return keep(await req('/api/auth/password-login', { method: 'POST', body: { email, password } })); };
export async function pkuVerify(email, code) {
  needDb();
  return keep(await req('/api/auth/pku-verify', { method: 'POST', body: { email, code } }));
}
// 刚注册／刚升级的分享者，人物页是开网页之后才建的，不在 PERSONS 里 → 补拉（不然「我的内容管理」整块空白）
export async function ensurePerson(pid) {
  if (pid && source === 'db' && !PERSONS.some((p) => p.id === pid)) PERSONS.push(await req(`/api/persons/${pid}`));
}

// 有库时出错回空，不退回示例通知（不然凭证失效时会冒出假通知）
// 启动时文章不带全文（content: null）；文章页／编辑页要全文时补拉单篇，回同一个 ARTICLES 物件
export async function loadArticle(id) {
  const a = ARTICLES.find((x) => x.id === id);
  if (!a || a.content != null || source !== 'db') return a;
  Object.assign(a, await req(`/api/articles/${id}`));
  return a;
}

export const notifications = () => (source === 'db' ? req('/api/notifications').catch(() => []) : Promise.resolve(NOTIFICATIONS));
export const markRead = (id) => write(`/api/notifications/${id}/read`, { method: 'POST' }, () => ({ ok: true }));
export const toggleStar = (id) => write(`/api/articles/${id}/star`, { method: 'POST' }, () => null);
export const toggleBookmark = (id) => write(`/api/articles/${id}/bookmark`, { method: 'POST' }, () => null);
export const toggleFollow = (id) => write(`/api/persons/${id}/follow`, { method: 'POST' }, () => null);

// 登录后拉「我的」：星标/收藏/关注转成 { id: true }，跟 AppState 的形状一致；没库时全空
const asMap = (ids) => Object.fromEntries(ids.map((id) => [id, true]));
export async function mine() {
  if (source !== 'db' || !token) return null;
  const [s, b, f, k] = await Promise.all(['stars', 'bookmarks', 'follows', 'bookings'].map((x) => call(`/api/me/${x}`, {}, () => [])));
  return { starred: asMap(s), bookmarked: asMap(b), following: asMap(f), bookings: k };
}

// 分享者：别人约我的（没库时空）
export const incomingBookings = () => (source === 'db' && token ? req('/api/me/incoming-bookings').catch(() => []) : Promise.resolve([]));

// b = BookingModal 传的 { personId, mentorName, duration, startsAt, slot, price, question }；价格以后端为准
// 时段被约走（409）要让用户看到，所以有库时出错直接抛，不退回 mock 假装成功
export async function addBooking(b) {
  const body = { personId: b.personId, minutes: b.duration, startsAt: b.startsAt, question: b.question };
  return source === 'db' ? req('/api/bookings', { method: 'POST', body }) : { id: `b${Date.now()}`, ...b };
}

// 可预约时段（以月为单位，北京时间整点 'YYYY-MM-DDTHH:MM'）。没库时都是空的
export const personSlots = (pid, month) => call(`/api/persons/${pid}/slots?month=${month}`, {}, () => []);
export const assistAvailability = (month, text, current) => call('/api/me/availability/assist', { method: 'POST', body: { month, text, current } },
  () => ({ slots: current, note: '', ask: '日历助手要连上后端和 LLM 才能用，先手动勾选吧' }));
export const assistSlots = (pid, month, text) => call(`/api/persons/${pid}/slots/assist`, { method: 'POST', body: { month, text } },
  () => ({ matches: [], note: '', ask: '日历助手要连上后端和 LLM 才能用，先手动选吧' }));
export const myAvailability = (month) => call(`/api/me/availability?month=${month}`, {}, () => []);
export const setAvailability = (month, slots) => write('/api/me/availability', { method: 'PUT', body: { month, slots } },
  () => slots.map((t) => ({ t, booked: false })));

export function viewArticle(id) {
  let viewer = null;
  try { viewer = localStorage.getItem('pf-viewer') || crypto.randomUUID(); localStorage.setItem('pf-viewer', viewer); } catch { /* 无痕模式 */ }
  return call(`/api/articles/${id}/view`, { method: 'POST', body: { viewer } }, () => null);
}

// 后端搜索（SSE）：on = { step, result, group, review }，各事件一到就回调；resolve done（{steps, llmCalls, cachedAt}）。
// 没库/断线/出错 resolve null（页面照旧用 mockSearch 算的关键词版）
export function agentSearch(q, on, signal) {
  if (source !== 'db' || !q.trim()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const es = new EventSource(`/api/search/stream?q=${encodeURIComponent(q)}`);
    const done = (v) => { es.close(); resolve(v); };
    signal?.addEventListener('abort', () => done(null));
    for (const kind of ['step', 'result', 'group', 'review']) es.addEventListener(kind, (e) => on[kind]?.(JSON.parse(e.data)));
    es.addEventListener('done', (e) => done(JSON.parse(e.data)));
    es.addEventListener('error', () => done(null)); // 后端回的 error 事件和连线断掉都走这里
  });
}

export async function createWish(q, filters) {
  const conditions = Object.fromEntries(Object.entries(filters).filter(([, v]) => v.length).map(([k, v]) => [k, v.join('/')]));
  const w = await write('/api/wishes', { method: 'POST', body: { query: q, conditions } }, () => addWish(q, filters));
  const i = WISH_REQUESTS.findIndex((x) => x.id === w.id); // 写作页 getWishRequest 读得到
  if (i < 0) WISH_REQUESTS.push(w); else WISH_REQUESTS[i] = w;
  return w;
}

export async function publish(article) {
  const { authorId, type, category, title, summary, content, tags, decisionPoints, requestId } = article;
  // 有库时失败（没登录、没验证北大）要报错，不能假装发成功；作者由后端按登录身份定
  if (source === 'db') return addArticle(await req('/api/articles', { method: 'POST', body: { type, category, title, summary, content, tags, decisionPoints, requestId } }));
  return addArticle({ ...article, authorId, decisionPoint: decisionPoints?.[0], decisionPoints });
}

// 作者改／删文章：后端失败要让页面知道（不退回 mock），成功才同步内存 ARTICLES
export async function updateArticle(id, title, content, decisionPoints) {
  const saved = source === 'db' ? await req(`/api/articles/${id}`, { method: 'PUT', body: { title, content, decisionPoints } })
    : { title, content, ...(decisionPoints && { decisionPoint: decisionPoints[0], decisionPoints }) };
  const i = ARTICLES.findIndex((a) => a.id === id);
  if (i >= 0) ARTICLES[i] = { ...ARTICLES[i], ...saved };
  return i >= 0 ? ARTICLES[i] : saved;
}
// 写作页「发布」第一步：大模型读全文抽决策点，回 { points, source }，给作者看过、改过再发；没后端回一个空白占位
export async function extractPoints(title, content) {
  if (source === 'db') return req('/api/articles/extract', { method: 'POST', body: { title, content } });
  return { points: [Object.fromEntries(DP_FIELDS.map((k) => [k, k === '考虑过的选项' ? [] : '未提及']))], source: 'none' };
}
export async function deleteArticle(id) {
  if (source === 'db') await req(`/api/articles/${id}`, { method: 'DELETE' });
  const i = ARTICLES.findIndex((a) => a.id === id);
  if (i >= 0) ARTICLES.splice(i, 1);
}

// 主题／热门／人物页「AI 帮我选」：一句话 → { filters: {决策类型, 学校层级, 专业, 结果}, irrelevant, results }
// results＝后端 LLM 抽条件＋RAG 向量召回＋rerank 排好的文章 id；没后端用关键词版，results: null（页面照 filters 筛）
export async function parseFilters(text) {
  return call(`/api/filters/parse?q=${encodeURIComponent(text)}`, {}, () => {
    const p = parseQuery(text);
    return { filters: Object.fromEntries(['决策类型', '学校层级', '专业', '结果'].map((k) => [k, p.filters[k] || []])), irrelevant: p.irrelevant, results: null };
  });
}

// 「AI 帮我选」第二步：召回文章的推荐理由（最多 30 篇） { 文章 id: {why, unique, quotes} }；没后端／LLM 不可用回 {}
export const pickWhy = async (text) => (await call(`/api/filters/why?q=${encodeURIComponent(text)}`, {}, () => ({ why: {} }))).why;

// 分享者改人物资料：成功回 { person, saved: true }；退回本地时 saved: false。两种都同步进内存 PERSONS
export async function updateProfile(fields) {
  const saved = await write('/api/me/profile', { method: 'PATCH', body: fields }, () => null);
  const person = saved || fields;
  const i = PERSONS.findIndex((x) => x.id === person.id);
  if (i >= 0) PERSONS[i] = { ...PERSONS[i], ...person };
  return { person: i >= 0 ? PERSONS[i] : person, saved: !!saved };
}

// ---------- 评价（评的是「有没有帮到我」，不是评人）。没库时用 mock.js 的 HELPFUL / REVIEWS ----------
const today = () => new Date().toISOString().slice(0, 10);
const mockHelpful = (id) => {
  const rows = HELPFUL[id] || [];
  return { count: rows.length, mine: rows.some((r) => r.me), comments: rows.filter((r) => r.comment) };
};
export const getHelpful = (id) => call(`/api/articles/${id}/helpful`, {}, () => mockHelpful(id));
export const markHelpful = (id, comment) => write(`/api/articles/${id}/helpful`, { method: 'POST', body: { comment } }, () => {
  HELPFUL[id] = [{ name: '我', comment, date: today(), me: true }, ...(HELPFUL[id] || []).filter((r) => !r.me)];
  return mockHelpful(id);
});
export const unmarkHelpful = (id) => write(`/api/articles/${id}/helpful`, { method: 'DELETE' }, () => {
  HELPFUL[id] = (HELPFUL[id] || []).filter((r) => !r.me);
  return mockHelpful(id);
});

export const myHelpful = () => call('/api/me/helpful', {}, () => Object.keys(HELPFUL).filter((id) => HELPFUL[id].some((r) => r.me)));

const mockHelped = (pid) => new Set(ARTICLES.filter((a) => a.authorId === pid).flatMap((a) => (HELPFUL[a.id] || []).map((r) => r.name))).size;
export const personStats = (pid) => call(`/api/persons/${pid}/stats`, {}, () => {
  const rs = REVIEWS[pid] || [];
  return {
    helpedCount: mockHelped(pid), ratingCount: rs.length, recentReviews: rs.slice(0, 5),
    ratingAvg: rs.length ? Math.round((rs.reduce((s, r) => s + r.stars, 0) / rs.length) * 10) / 10 : null,
  };
});
export const leaderboard = (limit = 5) => call(`/api/leaderboard/helpful?limit=${limit}`, {}, () =>
  PERSONS.map((p) => ({ id: p.id, name: p.name, helpedCount: mockHelped(p.id) }))
    .filter((p) => p.helpedCount).sort((a, b) => b.helpedCount - a.helpedCount).slice(0, limit));

export const completeReview = (b, stars, comment) => write(`/api/bookings/${b.id}/complete-review`, { method: 'POST', body: { stars, comment } }, () => {
  (REVIEWS[b.personId] ||= []).unshift({ name: '我', stars, comment, date: today() });
  return { ...b, status: 'done', review: { stars, comment } };
});

export const markPaid = (b) => write(`/api/bookings/${b.id}/paid`, { method: 'POST' }, () => ({ ...b, paid: true }));

// 上传图片（purpose: 'avatar' | 'payqr' | 'article'）。成功回 { url, saved: true }；
// 后端没开时回本地 blob 网址 { url, saved: false }，只在这个分页有效。格式/大小不对抛 Error(中文原因)
export async function uploadImage(file, purpose = 'article') {
  if (source === 'db') {
    const fd = new FormData();
    fd.append('file', file); fd.append('purpose', purpose);
    const r = await fetch('/api/uploads', { method: 'POST', body: fd, headers: token ? { 'X-Account-Id': token } : {} })
      .catch(() => null);
    if (r?.ok) return { ...(await r.json()), saved: true };
    if (r && r.status < 500) throw new Error((await r.json().catch(() => ({}))).detail || '上传失败');
  }
  return { url: URL.createObjectURL(file), saved: false };
}
