import { useState } from 'react';
import TrendingColumn from '../components/TrendingColumn';
import AskFilter from '../components/AskFilter';
import { matchRank } from '../components/WhyBlock';
import PageHead from '../components/PageHead';
import { PERSONS, trending } from '../data/mock';

// AI 拆出来的条件套到文章上：同栏位 OR、不同栏位 AND；日记没有决策点，学校层级／专业改看作者本人，结果不套
const FIELDS = ['学校层级', '专业', '结果'];
const diaryOk = (a, f) => {
  const p = PERSONS.find((x) => x.id === a.authorId);
  return (!f.学校层级.length || f.学校层级.includes(p?.schoolTier))
    && (!f.专业.length || (!!p?.major && f.专业.some((m) => p.major.includes(m) || m.includes(p.major))));  // 作者专业空白：不算符合任何专业（原本 ''.includes 恒真）
};
const match = (a, f) => (!f.决策类型.length || f.决策类型.includes(a.category))
  && (a.type === 'diary' ? diaryOk(a, f) : FIELDS.every((k) => !f[k].length || f[k].includes(a.decisionPoint?.[k])));

// 热门：两栏，各按最近 30 天点击人数排序；可以用说的缩小范围
// 经验文章：有 AI 匹配结果（大模型抽条件＋向量召回）就只留匹配到的，仍按点击排；日记不在召回范围，照条件筛
export default function TrendingPage() {
  const [f, setF] = useState(null);
  const [hits, setHits] = useState(null); // AI 匹配到的文章 id；null＝没后端，照 filters 筛
  const [why, setWhy] = useState({}); // 推荐理由
  const ok = (a) => !f || (hits && a.type === 'article' ? hits.has(a.id) : match(a, f));
  // 用说的筛过之后：先按红绿灯（很匹配在前），同一种灯再按点击
  const top = (type) => trending(type, 999).filter(ok).sort((x, y) => (f ? matchRank(why[x.id]) - matchRank(why[y.id]) : 0)).slice(0, 20);
  const fromAI = (filters, results) => { setF(filters); setHits(results && new Set(results)); };
  const picked = f ? Object.values(f).flat() : [];

  return (
    <div className="lm-pg">
      <PageHead label={<>热门<em>文章</em></>} title="热门文章" sub="按最近 30 天点击人数排序" />
      <div className="lm-wrap lm-pg-b">
        <AskFilter placeholder="想看哪类热门？例：最近推免光华的、双非进光华的" onResult={fromAI} onWhy={setWhy} />
        {f && <p className="lm-only">只看：{picked.join(' · ')}<button type="button" onClick={() => setF(null)}>看全部</button></p>}
        <div className="lm-two">
          <section className="lm-lsec"><h2>经验文章</h2><TrendingColumn label={f ? '符合条件的经验文章' : '经验文章'} items={top('article')} why={f ? why : {}} /></section>
          <section className="lm-lsec"><h2>人物日记</h2><TrendingColumn label={f ? '符合条件的人物日记' : '人物日记'} items={top('diary')} /></section>
        </div>
      </div>
    </div>
  );
}
