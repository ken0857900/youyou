// 搜索的前端部分（docs/03 流程 B）：后端召回的池子里再筛、分群、统计；没连后端时整条用关键词版。
import RULES from './searchRules.json';
import { ARTICLES, SCHOOL_TIERS, OUTCOMES, WISH_REQUESTS, isMentioned, stripImages } from './mock';

// 左栏篩选字段；「路径」不在左栏，由「走了哪些路」点选
export const FILTER_FIELDS = ['决策类型', '学校层级', '专业', '结果', '年级', '年份'];
export const PATH_FIELD = '路径';

// 关键词／路径／分群规则跟后端 backend/app/search.py 共用 searchRules.json
// 「最后的选择」写法五花八门（跨考计算机、保研外校⋯），走了哪些路只按粗路径数
const PATHS = RULES.PATHS.map(([p, re]) => [p, new RegExp(re)]);
const { DECISION_TYPES, TIER_RANK, GROUP_META } = RULES;
const UNRELATED = new RegExp(RULES.UNRELATED);
const INJECTION = new RegExp(RULES.INJECTION, 'i');
// 「申请光华金融硕士第二批」这种看不出来的，退回这篇的决策类型
export const coarsePath = (choice, kind) => PATHS.find(([, re]) => re.test(choice || ''))?.[0] || (DECISION_TYPES.includes(kind) ? kind : '其他');
// 取字段值：「路径」由最后的选择换算，其他直接读决策点
const val = (a, f) => (f === PATH_FIELD ? coarsePath(a.decisionPoint.最后的选择, a.decisionPoint.决策类型) : a.decisionPoint[f]);

// 只有正式文章有决策点；日记不进搜索。每次现读 ARTICLES，写作页新发布的也搜得到
const records = () => ARTICLES.filter((a) => a.type === 'article' && a.decisionPoint);

// ① 处境抽取（关键词版，后端 LLM 抽取不可用、或没连后端时用）
const KEYWORDS = RULES.KEYWORDS;

export function parseQuery(q) {
  const filters = Object.fromEntries([...FILTER_FIELDS, PATH_FIELD].map((f) => [f, []]));
  const labels = [];
  let grade;
  // 「保研失败转考研」里的失败是起点，不是这篇的结果：后面接转/后/再/改的「决策类型+失败」先拿掉；
  // 句尾的「考公失败」才是结果
  const qOutcome = q.replace(new RegExp(RULES.OUTCOME_PREFIX, 'g'), '');
  for (const [field, map] of KEYWORDS) {
    for (const [kw, value] of map) {
      if (!(field === '结果' ? qOutcome : q).includes(kw) || labels.includes(value)) continue;
      labels.push(value);
      if (field === '年级') grade ??= value; // 年级只当处境，不勾成硬条件
      else filters[field].push(value);
    }
  }
  const tokens = q.split(/[\s,，。.?？!！、]+/).filter((t) => t.length >= 2);
  const textHits = new Set(records().filter((a) => tokens.some((t) => `${a.title}${a.summary}${stripImages(a.content)}`.includes(t))).map((a) => a.id));
  return {
    filters,
    labels,
    textHits,
    situation: { 学校层级: filters.学校层级[0], 专业: filters.专业[0], 年级: grade }, // 读者自己的处境，分群用
    irrelevant: INJECTION.test(q) || (UNRELATED.test(q) && labels.length === 0), // 同后端：没命中关键词不代表无关
  };
}

// ② 过滤：同一字段内 OR，不同字段 AND；skip 用来算该字段每个选项的数量（电商式 facet）
export const matches = (a, filters, skip) =>
  Object.entries(filters).every(([f, vals]) => f === skip || vals.length === 0 || vals.includes(val(a, f)));

// 每个字段的可选值（固定顺序的用固定顺序，其余按出现顺序；「未提及」不当选项）
export function optionsFor(f) {
  const preset = { 学校层级: SCHOOL_TIERS, 结果: OUTCOMES }[f];
  const seen = [...new Set(records().map((a) => val(a, f)))].filter(isMentioned);
  return preset || (f === '年份' ? seen.sort() : seen);
}

export const countBy = (items, field) => {
  const c = {};
  for (const a of items) c[val(a, field)] = (c[val(a, field)] || 0) + 1;
  return c;
};

// ③ rerank（假）：符合抽取条件越多、命中搜索字越前面，同分看星星
export function rank(items, parsed) {
  const score = (a) =>
    Object.entries(parsed.filters).filter(([f, v]) => v.includes(val(a, f))).length * 2 + (parsed.textHits.has(a.id) ? 1 : 0);
  return [...items].sort((a, b) => score(b) - score(a) || b.stars - a.stars);
}

// 搜索结果：条件 + 没抽到条件时只留命中搜索字的
// skip：算某字段各选项数量时忽略该字段
// ids：后端 RAG 召回的文章 id（已按 rerank 排好），给了就只在这些里面筛、保持原顺序
export function search(parsed, filters, skip, ids) {
  if (ids?.length) { // 召回 0 篇当没给，退回关键词版
    const byId = new Map(records().map((a) => [a.id, a]));
    return ids.map((id) => byId.get(id)).filter((a) => a && matches(a, filters, skip));
  }
  const noConds = parsed.labels.length === 0 && parsed.textHits.size > 0;
  return rank(records().filter((a) => matches(a, filters, skip) && (!noConds || parsed.textHits.has(a.id))), parsed);
}

// ④ 分群（程式）：抽到处境就按学校层级 + 专业跟读者比（跟你最像／起点比你好／跨专业／其他）；没抽到就按层级或专业分。
function relationOf(dp, s) {
  const tierOk = !s.学校层级 || dp.学校层级 === s.学校层级;
  const majorOk = !s.专业 || dp.专业 === s.专业;
  if (tierOk && majorOk) return 'same';
  if (s.学校层级 && TIER_RANK[dp.学校层级] > TIER_RANK[s.学校层级] && majorOk) return 'better';
  if (s.专业 && isMentioned(dp.专业) && dp.专业 !== s.专业 && tierOk) return 'cross'; // 没写专业不算跨专业
  return 'other';
}

function bucket(items, keyOf) {
  const map = new Map();
  for (const a of items) {
    const k = keyOf(a);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(a);
  }
  return map;
}

export function groupResults(items, situation) {
  if (situation.学校层级 || situation.专业) {
    const m = bucket(items, (a) => relationOf(a.decisionPoint, situation));
    return ['same', 'better', 'cross', 'other'].filter((k) => m.has(k)).map((k) => ({ id: k, ...GROUP_META[k], members: m.get(k) }));
  }
  // 没抽到处境：按学校层级分，只有一种层级就按专业分；人多的群在前
  let field = '学校层级';
  let m = bucket(items, (a) => a.decisionPoint[field]);
  if (m.size < 2) m = bucket(items, (a) => a.decisionPoint[(field = '专业')]);
  return [...m.entries()]
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([k, members]) => ({ id: `${field}-${k}`, name: field === '学校层级' ? (k === '未提及' ? '起点没写' : `${k} 出发`) : k, icon: '👥', members }));
}

// 另算「起点比你好」（docs 决策 B2）：左栏会自动勾读者的学校层级，主分群就看不到层级更高的人，
// 所以这群从「不套学校层级筛选」的池子里挑：层级比读者高、同专业（没抽到专业就不限）。
// 读者 985 / 没抽到层级 / 主分群已经有「起点比你好」/ 没人 → 不显示
export function betterGroup(parsed, filters, mainGroups) {
  const s = parsed.situation;
  const mine = TIER_RANK[s.学校层级];
  if (!mine || mine === 3 || mainGroups.some((g) => g.id === 'better')) return null;
  const members = search(parsed, filters, '学校层级').filter(
    (a) => TIER_RANK[a.decisionPoint.学校层级] > mine && (!s.专业 || a.decisionPoint.专业 === s.专业),
  );
  if (!members.length) return null;
  const tiers = SCHOOL_TIERS.filter((t) => members.some((a) => a.decisionPoint.学校层级 === t));
  return { id: 'better-extra', ...GROUP_META.better, label: `起点比你好（${tiers.join('／')}，不受学校层级筛选影响）`, members };
}

// 群内统计（程式算，不让 LLM 数数）
export const groupStats = (members) => ({ paths: countBy(members, PATH_FIELD), outcomes: countBy(members, '结果') });

// 检索过程面板：没有后端日志时（读者改了筛选、没连后端）只写前端真的做了的事，不编召回数、agent 步骤和耗时
// filters＝读者目前勾的条件；changed＝有后端、是读者改了筛选（AI 只对原本的条件判断过）
export function processLog(filters, results, mainGroups, fallback, extra, changed) {
  const picked = Object.entries(filters).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.join('/')}`);
  const steps = [`按条件筛选（程式）${picked.length ? picked.join('；') : '没有条件'} → ${results.length} 篇`];
  if (fallback) return [...steps, '分群跳过，显示最相关的 5 篇'];
  steps.push(`分群＋统计（程式）${mainGroups.map((g) => `${g.name} ${g.members.length}`).join(' / ') || '不分群'}` +
    (extra ? ` + 「起点比你好」${extra.members.length} 人（不套学校层级筛选）` : ''));
  steps.push(changed ? '改了筛选条件：AI 判断与审查只对原本的条件做过，这里是规则版分群' : '没连上后端：关键词版，没有 AI 判断');
  return steps;
}

// 找不到时：拿掉每个已勾条件后剩几条
export function removalCounts(parsed, filters) {
  const out = [];
  for (const [f, vals] of Object.entries(filters)) {
    for (const v of vals) {
      const next = { ...filters, [f]: vals.filter((x) => x !== v) };
      const count = search(parsed, next).length;
      if (count > 0) out.push({ field: f, value: v, count, next });
    }
  }
  return out;
}

// 最接近的经验：符合的已勾字段越多越近；差别逐栏比对
export function closest(filters, limit = 2) {
  const active = Object.entries(filters).filter(([, v]) => v.length);
  return records().map((a) => {
    const diffs = active.filter(([f, v]) => !v.includes(val(a, f))).map(([f, v]) => `${f}是 ${val(a, f)}，不是 ${v.join('/')}`);
    return { article: a, diffs };
  })
    .sort((x, y) => x.diffs.length - y.diffs.length || y.article.stars - x.article.stars)
    .filter((x, i, arr) => arr.findIndex((y) => y.article.authorId === x.article.authorId) === i) // 同一人只出现一次
    .slice(0, limit);
}

// 我想看：同一搜索字合并计数，否则新建求经验单。没后端时写进内存数组（api.createWish 的退路）
export function addWish(q, filters) {
  let w = WISH_REQUESTS.find((x) => x.query === q);
  if (w) w.wantCount += 1;
  else {
    const conditions = Object.fromEntries(Object.entries(filters).filter(([, v]) => v.length).map(([k, v]) => [k, v.join('/')]));
    w = { id: `w${Date.now()}`, query: q, conditions, wantCount: 1, status: '等待中' };
    WISH_REQUESTS.push(w);
  }
  return w;
}
