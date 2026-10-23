import { Link } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import { getArticle } from '../data/mock';
import SampleBadge from './SampleBadge';
import { MatchLight } from './WhyBlock';

// 人物卡（人物页是「选人」）：头像＋名字＋本科层级·专业 → 后来怎么走 → 成绩。同一件事只出现一次：
// 经历（title）第一段就是本科背景，名字下已有 → 去掉；成绩从时间线挑写了排名／绩点／GPA 的那一句；自述是文章开场白，选人用不到，不放
// pick（可选）：「AI 帮我选」时他被匹配到、红绿灯最好的那篇 {id, match}；只给一行文章标题，理由原话留给主题／热门页
const route = (title = '') => { const s = title.split('→').map((x) => x.trim()); return (s.length > 1 ? s.slice(1) : s).join(' → '); };
const grade = (timeline) => (timeline || []).flatMap((t) => (t.desc || '').split(/[，,；]/)).find((x) => /排名|绩点|GPA/.test(x))?.trim();

export default function PersonCard({ person, pick }) {
  const { following, toggleFollow } = useAppState();
  const on = !!following[person.id];
  const want = pick && getArticle(pick.id);
  const g = grade(person.timeline);
  return (
    <article className="lm-pc">
      <div className="lm-pc-t">
        <img src={person.avatar} alt="" />
        <div style={{ minWidth: 0 }}>
          <h3><Link to={`/people/${person.id}`}>{person.name}</Link><SampleBadge of={person} lm /><MatchLight level={pick?.match} /></h3>
          <p>本科 {[person.schoolTier, person.major].filter(Boolean).join(' · ')}</p>
        </div>
        <button type="button" aria-pressed={on} onClick={() => toggleFollow(person.id)}>{on ? '已关注' : '＋ 关注'}</button>
      </div>
      {person.title && <p className="tt">{route(person.title)}</p>}
      {g && <p className="gr"><b>成绩</b>{g}</p>}
      {want && <Link className="want" to={`/articles/${want.id}`}><small>你可能想看</small>{want.title}<span aria-hidden="true">→</span></Link>}
      <div className="tags">{person.tags.map((t) => <span key={t}>#{t}</span>)}</div>
      <div className="lm-pc-f">
        {person.reviewCount ? <span><b>★ {person.rating}</b><small>（{person.reviewCount}）</small></span> : <small>还没有评价</small>}
        <Link to={`/people/${person.id}`}>查看个人页<span aria-hidden="true">→</span></Link>
      </div>
    </article>
  );
}
