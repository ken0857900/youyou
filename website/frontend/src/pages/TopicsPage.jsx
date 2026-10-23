import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import ArticleCard from '../components/ArticleCard';
import AskFilter from '../components/AskFilter';
import { matchRank } from '../components/WhyBlock';
import PageHead from '../components/PageHead';
import { ARTICLES, CATEGORIES, OUTCOMES, SCHOOL_TIERS, categoryById } from '../data/mock';


// 一排筛选按钮；再点一次已选的 = 取消。给 limit 就先只显示前 limit 个（已选的那个一定显示），可展开／收起
function FilterRow({ label, options, value, onChange, limit }) {
  const [open, setOpen] = useState(false);
  const folded = limit && options.length > limit && !open;
  const shown = folded ? [...new Set([...options.slice(0, limit), ...(value ? [value] : [])])] : options;
  return (
    <div className="lm-frow">
      <span>{label}</span>
      <button type="button" className="lm-fp" aria-pressed={!value} onClick={() => onChange(null)}>不限</button>
      {shown.map((o) => <button key={o} type="button" className="lm-fp" aria-pressed={o === value} onClick={() => onChange(o === value ? null : o)}>{o}</button>)}
      {limit && options.length > limit && (
        <button type="button" className="lm-fp more" onClick={() => setOpen(!open)}>{open ? '收起 ▴' : `展开全部 ${options.length} 个 ▾`}</button>
      )}
    </div>
  );
}

// 换分类时整个重挂载，筛选自动清空（避免旧筛选把新分类筛成空）
// 推荐理由放外层：AI 帮我选换分类会重挂载 Topics，理由晚到也不会丢
export default function TopicsPage() {
  const [params] = useSearchParams();
  const [why, setWhy] = useState({});
  return <Topics key={params.get('cat') ?? 'all'} why={why} setWhy={setWhy} />;
}

// 光华的项目（参赛版只收光华）：没有结构化字段，按标题／摘要／最后的选择／结果说明里的关键字找
const PROGRAMS = [['高金', ['高金']], ['科创金融', ['科创']], ['金融学', ['金融学方向', '金融学第', '光华金融学']], ['商业分析', ['商业分析']],
  ['会计硕士', ['会计硕士', '会计专硕']], ['学术营', ['学术营', '学术夏令营', '直博']], ['MBA', ['MBA']]];
const inProgram = (a, name) => {
  const keys = PROGRAMS.find(([n]) => n === name)?.[1] || [];
  const text = [a.title, a.summary, a.decisionPoint?.最后的选择, a.decisionPoint?.结果说明].join(' ');
  return keys.some((k) => text.includes(k));
};

function Topics({ why, setWhy }) {
  const [params, setParams] = useSearchParams();
  const hits = useLocation().state?.hits; // AI 帮我选：大模型抽条件＋向量召回的文章 id（按匹配先后）；点分类标签就离开 AI 结果
  const cat = categoryById(params.get('cat')); // 没带 cat = 全部主题
  // 起点／项目／结果也放网址里：「AI 帮我选」一次换分类＋筛选，重挂载后还在
  const [tier, prog, outcome] = ['tier', 'prog', 'outcome'].map((k) => params.get(k));
  const setOne = (k) => (v) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { state: { hits } }); };
  const [setTier, setProg, setOutcome] = ['tier', 'prog', 'outcome'].map(setOne);
  const fromAI = (f, results) => {
    const c = CATEGORIES.find((x) => x.name === f.决策类型[0]);
    setParams(Object.fromEntries([['cat', c?.id], ['tier', f.学校层级[0]], ['outcome', f.结果[0]]].filter(([, v]) => v)),
      { state: { hits: results } });
  };

  const all = ARTICLES.filter((a) => a.type === 'article');
  const byId = new Map(all.map((a) => [a.id, a]));
  const base = hits ? hits.map((id) => byId.get(id)).filter(Boolean) : all; // 有 AI 结果：只在匹配到的里面筛，保持匹配顺序
  const list = base.filter((a) => {
    const dp = a.decisionPoint;
    return (!cat || a.category === cat.name) && (!tier || dp.学校层级 === tier) && (!prog || inProgram(a, prog)) && (!outcome || dp.结果 === outcome);
  });
  if (hits) list.sort((x, y) => matchRank(why[x.id]) - matchRank(why[y.id])); // AI 结果按红绿灯排

  return (
    <div className="lm-pg">
      <PageHead label={<>主题<em>分类</em></>} title="主题分类" />
      <div className="lm-wrap lm-pg-b">
        <AskFilter placeholder="用一句话说想看什么，例：没拿到光华优营的、光华学术营直博" onResult={fromAI} onWhy={setWhy} />
        <div className="lm-ktab" role="tablist" aria-label="主题">
          <button type="button" role="tab" aria-selected={!cat} onClick={() => setParams({})}>全部主题</button>
          {CATEGORIES.map((c) => <button key={c.id} type="button" role="tab" aria-selected={cat?.id === c.id} onClick={() => setParams({ cat: c.id })}>{c.name}</button>)}
        </div>
        {cat && <p className="lm-desc">{cat.desc}</p>}
        <div className="lm-frows">
          <FilterRow label="起点" options={SCHOOL_TIERS} value={tier} onChange={setTier} />
          <FilterRow label="光华项目" options={PROGRAMS.map(([n]) => n)} value={prog} onChange={setProg} />
          <FilterRow label="结果" options={OUTCOMES} value={outcome} onChange={setOutcome} />
        </div>
        <section>
          <h2 className="lm-res-h">{hits ? 'AI 匹配的' : ''}{cat ? cat.name : '全部'}经验文章<small>{list.length} 篇</small></h2>
          {list.length === 0 ? <p className="lm-empty">没有符合条件的文章，换个筛选试试。</p>
            : <div className="lm-cards">{list.map((a) => <ArticleCard key={a.id} article={a} why={hits && why[a.id]} />)}</div>}
        </section>
      </div>
    </div>
  );
}
