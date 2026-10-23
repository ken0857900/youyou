import { useState } from 'react';
import PersonCard from '../components/PersonCard';
import HelpfulBoard from '../components/HelpfulBoard';
import AskFilter from '../components/AskFilter';
import { matchRank } from '../components/WhyBlock';
import PageHead from '../components/PageHead';
import { ARTICLES, PERSONS, CATEGORIES, SCHOOL_TIERS, articlesByAuthor } from '../data/mock';

const DECISION_TYPES = CATEGORIES.map((c) => c.name);
const Chip = ({ active, onClick, children }) => (
  <button type="button" className="lm-fp" aria-pressed={active} onClick={onClick}>{children}</button>
);

export default function PeoplePage() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [tier, setTier] = useState('');
  const [ranked, setRanked] = useState(null); // AI 匹配到的人物 id（按匹配先后）；null＝没搜／没后端
  const [why, setWhy] = useState({}); // 推荐理由（按文章 id）
  // AI 帮我选：大模型抽条件＋向量召回的文章，作者按匹配先后排成人物；按钮只有单选，取第一个认得的决策类型／学校层级
  const fromAI = (f, results) => {
    setType(f.决策类型.find((t) => DECISION_TYPES.includes(t)) || '');
    setTier(f.学校层级.find((t) => SCHOOL_TIERS.includes(t)) || '');
    const author = new Map(ARTICLES.map((a) => [a.id, a.authorId]));
    setRanked(results && [...new Set(results.map((id) => author.get(id)).filter(Boolean))]);
  };
  // 一个人可能有好几篇被匹配到：取红绿灯最好的那篇（卡片上给它的标题＋灯）
  const whyOf = (pid) => Object.entries(why).filter(([id]) => ARTICLES.find((a) => a.id === id)?.authorId === pid)
    .map(([id, w]) => ({ ...w, id })).sort((x, y) => matchRank(x) - matchRank(y))[0];
  const typing = (s) => { setQ(s); setRanked(null); };
  // 同一个框：打的字对得上姓名就按姓名筛，对不上（是一句话）就不套，等按 AI 帮我选
  const name = PERSONS.some((p) => p.name.includes(q.trim())) ? q.trim() : '';
  const pool = ranked ? ranked.map((id) => PERSONS.find((p) => p.id === id)).filter(Boolean) : PERSONS;
  const list = pool.filter((p) =>
    p.name.includes(name)
    && (!tier || p.schoolTier === tier)
    && (!type || articlesByAuthor(p.id, 'article').some((a) => a.category === type)));
  if (ranked) list.sort((x, y) => matchRank(whyOf(x.id)) - matchRank(whyOf(y.id))); // AI 结果按红绿灯排

  return (
    <div className="lm-pg">
      <PageHead label={<>人物<em>资料库</em></>} title="人物资料库" />
      <div className="lm-wrap lm-pg-b">
        <HelpfulBoard />
        <div style={{ display: 'grid', gap: 12 }}>
          <AskFilter placeholder="输入姓名，或用一句话说想找谁，例：九推进光华的学长" onResult={fromAI} onText={typing} onWhy={setWhy} />
          <div className="lm-frow"><span>决策类型</span><Chip active={!type} onClick={() => setType('')}>全部</Chip>{DECISION_TYPES.map((t) => <Chip key={t} active={type === t} onClick={() => setType(t)}>{t}</Chip>)}</div>
          <div className="lm-frow"><span>学校层级</span><Chip active={!tier} onClick={() => setTier('')}>全部</Chip>{SCHOOL_TIERS.map((t) => <Chip key={t} active={tier === t} onClick={() => setTier(t)}>{t}</Chip>)}</div>
        </div>
        {list.length === 0 ? <p className="lm-empty">没有符合条件的人物</p>
          : <div className="lm-pcs">{list.map((p) => <PersonCard key={p.id} person={p} pick={ranked && whyOf(p.id)} />)}</div>}
      </div>
    </div>
  );
}
