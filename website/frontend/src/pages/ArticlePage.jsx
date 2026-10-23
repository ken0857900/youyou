import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import { getArticle, getPerson, starCount } from '../data/mock';
import { getHelpful, loadArticle, markHelpful, unmarkHelpful, viewArticle } from '../data/api';
import BookingModal from '../components/BookingModal';
import NotFoundPage from './NotFoundPage';
import ArticleBody from '../components/ArticleBody';
import SampleBadge from '../components/SampleBadge';
import './article.css';

// 文章页（新设计：单栏书页、决策之路、经验保鲜度旁注）。功能、资料照原本的，只换版面

// 返回上一页：有站内历史就 navigate(-1)，直接打开链接（idx 0）就去 fallback。PersonPage 也用这个
// oxlint-disable-next-line react/only-export-components -- 小按钮先跟页面放一起
export function BackButton({ fallback }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate(fallback))} className="lm-back w-fit">
      ← 返回上一页
    </button>
  );
}

// 决策点＝一条「决策之路」：背景一行小字 → 考虑过的选项 → 最后的选择 → 结果小方印＋说明 → 原话；没写到（未提及／空）的字段略过
function DecisionPath({ dp }) {
  const has = (k) => { const v = dp[k]; return Array.isArray(v) ? v.length > 0 : !!v && v !== '未提及'; };
  const who = [
    has('决策类型') && <Fragment key="t">决策类型 <b>{dp.决策类型}</b></Fragment>,
    (has('学校层级') || has('专业')) && <Fragment key="s">{has('学校层级') && <b>{dp.学校层级}</b>}{has('学校层级') && has('专业') && ' · '}{has('专业') && dp.专业}</Fragment>,
    has('成绩') && dp.成绩, has('年级') && dp.年级, has('年份') && `${dp.年份} 年`,
  ].filter(Boolean);
  const opts = has('考虑过的选项') ? [dp.考虑过的选项].flat() : [];
  const seal = { 成功: 'ok', 失败: 'fail', 转向: 'turn' }[dp.结果] || '';
  const steps = [
    opts.length > 0 && <div key="f" className="dp-fork">{opts.map((o) => <span key={o} className={o === dp.最后的选择 ? 'on' : undefined}>{o}</span>)}</div>,
    has('最后的选择') && <div key="c" className="dp-choice">{dp.最后的选择}</div>,
    (has('结果') || has('结果说明')) && <div key="r" className="dp-res">{has('结果') && <span className={`dp-seal ${seal}`}>{dp.结果}</span>}{has('结果说明') && <p>{dp.结果说明}</p>}</div>,
  ].filter(Boolean);
  return (
    <div className="dpb">
      <p>决策点<small>· AI 从文章中提取</small></p>
      {who.length > 0 && <div className="dp-who"><div>{who.map((w, i) => <span key={i}>{w}</span>)}</div></div>}
      {steps.length > 0 && (
        <div className="dp-path">{steps.map((s, i) => <Fragment key={i}>{i > 0 && <span className="dp-arrow" aria-hidden="true" />}{s}</Fragment>)}</div>
      )}
      {has('原话') && <blockquote>「{dp.原话}」</blockquote>}
    </div>
  );
}

// 「有帮到我」：评的是这篇对你有没有用，不是评作者本人
function HelpfulBox({ articleId }) {
  const { user } = useAppState();
  const navigate = useNavigate();
  const [h, setH] = useState(null);
  const [text, setText] = useState('');
  useEffect(() => { getHelpful(articleId).then(setH); }, [articleId, user]);
  if (!h) return null;
  const submit = async (e) => {
    e.preventDefault();
    if (!user) return navigate('/login');
    try { setH(await markHelpful(articleId, text.trim())); setText(''); } catch (err) { alert(err.message); }
  };
  return (
    <section className="hp">
      <p>只评这篇对你有没有用，不评作者本人——失败经验一样能帮到人。</p>
      <form onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="选填：哪里帮到你了？（200 字内）" aria-label="哪里帮到你了" />
        <button type="submit" className="lm-btn-line">{h.mine ? (text.trim() ? '更新短评' : '已觉得有帮助') : '这篇有帮到我'}</button>
        {h.mine && <button type="button" className="lm-back" onClick={() => unmarkHelpful(articleId).then(setH, (err) => alert(err.message))}>取消</button>}
      </form>
      <p className="n">{h.count} 人觉得有帮助</p>
      {h.comments.length > 0 && (
        <ul>{h.comments.map((c, i) => <li key={i}><b>{c.name}</b><small>{c.date}</small><p>{c.comment}</p></li>)}</ul>
      )}
    </section>
  );
}

export default function ArticlePage() {
  const { id } = useParams();
  const article = getArticle(id);
  const { starred, bookmarked, toggleStar, toggleBookmark } = useAppState(); // 访客点推荐/收藏 → 跳登录（AppState 里挡，docs/04 第四节）
  const [booking, setBooking] = useState(false);
  const [, setLoaded] = useState(0); // 全文补拉回来后重画
  useEffect(() => { if (article?.content == null) loadArticle(id).then(() => setLoaded((n) => n + 1)).catch(() => {}); }, [id, article]);
  useEffect(() => { if (article) viewArticle(id); }, [id, article]); // 30 天热门按不同点击人数算
  if (!article) return <NotFoundPage />;
  const author = getPerson(article.authorId);
  const isDiary = article.type === 'diary';
  const fresh = article.content != null && article.claims?.length > 0;  // 有核验：电脑版正文旁边多一栏旁注

  return (
    <article className={`lm-ar${fresh ? ' has-fr' : ''}`}>
      <div><BackButton fallback={`/people/${article.authorId}`} /></div>
      <header className="ar-h">
        <div className="ar-cat"><span className="c">{isDiary ? `人物日记 · ${article.category}` : article.category}</span><SampleBadge of={article} lm /></div>
        <h1>{article.title}</h1>
        <p className="ar-meta">{author?.name} · 发布于 {article.date} · 预计阅读 {article.readTime}</p>
      </header>
      <p className="ar-sum">{article.summary}</p>
      {!isDiary && article.decisionPoint && <DecisionPath dp={article.decisionPoint} />}
      {article.content == null ? <div className="ar-body"><p>正文载入中…</p></div> : <ArticleBody text={article.content} claims={article.claims} />}
      <div className="ar-act">
        <button type="button" className={starred[article.id] ? 'on' : undefined} aria-pressed={!!starred[article.id]} onClick={() => toggleStar(article.id)}>
          {starred[article.id] ? '★' : '☆'} 推荐<small>{starCount(article, starred)}</small>
        </button>
        <button type="button" className={bookmarked[article.id] ? 'on' : undefined} aria-pressed={!!bookmarked[article.id]} onClick={() => toggleBookmark(article.id)}>
          {bookmarked[article.id] ? '已收藏' : '收藏'}
        </button>
      </div>
      <HelpfulBox articleId={article.id} />
      {author && (
        <div className="au">
          <div className="au-id"><img className="lm-seal-av" src={author.avatar} alt="" /><div><b>{author.name}</b><small>{author.title}</small></div></div>
          <div className="au-act">
            <Link className="lm-btn-ink" to={`/people/${author.id}`}>查看作者完整页面</Link>
            {author.consultationAvailable && <button type="button" className="lm-btn-book" onClick={() => setBooking(true)}>预约 ¥{author.price20m} 起</button>}
          </div>
        </div>
      )}
      {booking && <BookingModal person={author} onClose={() => setBooking(false)} />}
    </article>
  );
}
