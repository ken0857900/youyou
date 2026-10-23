import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { myHelpful } from '../data/api';
import { useAppState } from '../context/AppState';
import { ARTICLES, PERSONS, getPerson } from '../data/mock';
import PageHead from '../components/PageHead';

// 我的关注、推荐与收藏（新设计：书目式清单）
function Section({ label, items, empty, row }) {
  return (
    <section className="lm-lsec">
      <h2>{label}<small>{items.length}</small></h2>
      {items.length === 0 ? <p className="lm-empty">还没有{empty}</p> : <div className="lm-blist">{items.map(row)}</div>}
    </section>
  );
}
const artRow = (it) => (
  <Link key={it.id} to={`/articles/${it.id}`}>
    <div className="grow"><span className="m">{it.type === 'diary' ? '人物日记' : '经验文章'} · {getPerson(it.authorId)?.name} · {it.date}</span><h3>{it.title}</h3></div>
    <span className="go" aria-hidden="true">→</span>
  </Link>
);

export default function LibraryPage() {
  const { user, starred, bookmarked, following } = useAppState();
  const followed = PERSONS.filter((p) => following[p.id]);
  const [helpful, setHelpful] = useState([]);
  useEffect(() => { if (user) myHelpful().then(setHelpful); }, [user]);
  if (!user) return <Navigate to="/login" replace />;
  return (
    <div className="lm-pg">
      <PageHead label={<>关注<em>与收藏</em></>} title="我的关注、推荐与收藏" />
      <div className="lm-wrap lm-narrow">
        <Section label="关注" items={followed} empty="关注任何人" row={(p) => (
          <Link key={p.id} to={`/people/${p.id}`}><img src={p.avatar} alt="" /><div className="grow"><h3>{p.name}</h3><span className="m">{p.title}</span></div><span className="go" aria-hidden="true">→</span></Link>
        )} />
        <Section label="有帮到我" items={ARTICLES.filter((a) => helpful.includes(a.id))} empty="按过「这篇有帮到我」的文章" row={artRow} />
        <Section label="推荐" items={ARTICLES.filter((a) => starred[a.id])} empty="推荐任何文章或日记" row={artRow} />
        <Section label="收藏" items={ARTICLES.filter((a) => bookmarked[a.id])} empty="收藏任何文章或日记" row={artRow} />
      </div>
    </div>
  );
}
