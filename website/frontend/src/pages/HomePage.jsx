import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ARTICLES, CATEGORIES, HERO_SLIDES, PERSONS, categoryById, getPerson, trending } from '../data/mock';
import { leaderboard } from '../data/api';
import { useSearchModal } from '../components/SearchModal';
import SampleBadge from '../components/SampleBadge';
import './home.css';

// 首页（新设计，照设计稿 逐页讨论.html）：水墨未名湖 hero → 燕园四时 → 主题分类 → 热门文章＋有帮到我 → 推荐分享者
// 资料全接真的（人物、文章、分类、有帮到我排行）；动画在 homeScene.js，只在首页载入（three.js、gsap）
const QUICK_QUERIES = ['光华金融硕士', '光华夏令营', '没拿到优营', '九推', '直博还是读硕', '跨专业申光华'];  // 参赛版只收光华示例
const CN = '一二三四五六';
// 燕园四时：每一季对到那时候正在烦恼的决定，点了去主题分类；照片读 hero_slides 表（/api/hero），没库时用 data/brandPhotos.js
const SEASONS = [
  { s: '春', months: [3, 4, 5], label: '3–5 月', note: '暑期实习投递、夏令营报名', cats: ['qiuzhi', 'baoyan'] },
  { s: '夏', months: [6, 7, 8], label: '6–8 月', note: '夏令营、出国申请准备', cats: ['baoyan', 'chuguo'] },
  { s: '秋', months: [9, 10, 11], label: '9–11 月', note: '九推、秋招', cats: ['baoyan', 'qiuzhi'] },
  { s: '冬', months: [12, 1, 2], label: '12–2 月', note: '考研初试、考公', cats: ['kaoyan', 'kaogong'] },
];
const catCount = (name) => ARTICLES.filter((a) => a.type === 'article' && a.category === name).length;

function Season({ x, now }) {
  const p = HERO_SLIDES.find((h) => h.season === x.s);
  return (
    <article className={`season${now ? ' now' : ''}`} aria-current={now ? 'date' : undefined}>
      {p && <img src={p.url} alt={p.alt} loading="lazy" decoding="async" />}
      <span className="ss">{x.s}</span>
      {now && <span className="ss-now">此时</span>}
      <div className="ss-b">
        <small>{x.label}</small>
        <p>{x.note}</p>
        <div className="ss-links">
          {x.cats.map(categoryById).map((c) => [c, catCount(c.name)]).filter(([, n]) => n).map(([c, n]) => <Link key={c.id} to={`/topics?cat=${c.id}`}>{c.name} <b>{n}</b> 篇 →</Link>)}
        </div>
      </div>
      {p && <small className="ss-credit">{p.credit}</small>}
    </article>
  );
}

export default function HomePage() {
  const open = useSearchModal();
  const root = useRef(null);
  const askBtn = useRef(null);
  const [tab, setTab] = useState('a');
  const [board, setBoard] = useState([]);
  useEffect(() => { leaderboard(5).then(setBoard); }, []);
  useEffect(() => {
    let cleanup = null, dead = false;
    import('./homeScene.js').then((m) => { if (!dead && root.current) cleanup = m.mount(root.current); });
    return () => { dead = true; cleanup?.(); };
  }, []);

  const rank = (type) => trending(type, 5);
  const scrollPeople = (dir) => {
    const box = root.current.querySelector('.people');
    box.scrollBy({ left: dir * box.clientWidth * 0.8, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  return (
    <div className="lm-home" ref={root}>
      <section className="hero snap-pt lm-bleed" id="home-hero">
        <canvas aria-hidden="true" />
        <div className="lm-wrap">
          <div className="hero-l">
            <span className="label lx lx-hero"><span className="lx-t">问前路，找<em>鹿鸣</em></span></span>
            <p className="sub">你的困惑，有人懂；你的前路，有人同行。<br />说说你的处境，看当年处境最像的人怎么选。</p>
            {/* 搜索框外观是输入框，其实是按钮：点了开搜索弹窗；关掉后焦点回这里，键盘前后切都不会被困住 */}
            <form className="sbox" onSubmit={(e) => { e.preventDefault(); open({ from: askBtn.current }); }}>
              <p className="s-q">你现在卡在哪个决定？</p>
              <div className="s-row">
                <svg className="s-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" strokeLinecap="round" /></svg>
                <button ref={askBtn} type="button" className="s-fake" aria-label="说说你现在的处境（打开搜索）" onClick={(e) => open({ from: e.currentTarget })}><span /></button>
                <button className="s-go" type="submit" tabIndex={-1} aria-hidden="true">找相似经历<span aria-hidden="true">→</span></button>
              </div>
            </form>
            <div className="chips"><span>热门搜索</span>
              {QUICK_QUERIES.map((q) => <button key={q} type="button" onClick={(e) => open({ q, from: e.currentTarget })}>{q}</button>)}
            </div>
            <Link className="meet" to="/#section-people">认识分享者 →</Link>
          </div>
          <h1 className="hero-v"><span className="hv-a">问前路</span><span className="hv-b">找鹿鸣</span></h1>
        </div>
        <span className="hint" />
      </section>

      <section className="lake snap-pt" aria-labelledby="lake-h">
        <div className="lm-wrap">
          <div className="lake-intro">
            <span className="label lx lx-yan"><span className="lx-t">燕园<em>四时</em></span></span>
            <h2 id="lake-h">燕园四时，各有各的抉择</h2>
          </div>
          <div className="seasons">
            {SEASONS.map((x) => <Season key={x.s} x={x} now={x.months.includes(new Date().getMonth() + 1)} />)}
          </div>
        </div>
      </section>

      <div className="lm-wrap">
        <section className="sec snap-pt" id="section-topics">
          <div className="sec-head"><span className="fish">◆</span><h2>主题分类探索</h2><Link className="more" to="/topics">查看全部 →</Link></div>
          <div className="cats">
            {CATEGORIES.map((c) => <Link key={c.id} className="cat" to={`/topics?cat=${c.id}`}><i>{c.name[0]}</i><h3>{c.name}</h3><p>{c.desc}</p></Link>)}
          </div>
        </section>

        <section className="sec snap-pt" id="section-trending">
          <div className="sec-head"><span className="fish">◆</span><h2>热门文章</h2><p>近三十日 · 按阅读人数排名</p><Link className="more" to="/trending">查看全部 →</Link></div>
          <div className="two">
            <div>
              <div className="ktab" role="tablist" aria-label="文章类型">
                <button type="button" role="tab" aria-selected={tab === 'a'} onClick={() => setTab('a')}>经验文章</button>
                <button type="button" role="tab" aria-selected={tab === 'd'} onClick={() => setTab('d')}>人物日记</button>
              </div>
              <ol className="rank">
                {rank(tab === 'a' ? 'article' : 'diary').map((a, i) => (
                  <li key={a.id}>
                    <span className="n">{CN[i]}</span>
                    <div>
                      <h3><Link to={`/articles/${a.id}`}>{a.title}</Link></h3>
                      <p className="ex">{a.summary}</p>
                      <p className="by">{getPerson(a.authorId)?.name} · {a.type === 'diary' ? '人物日记' : a.category} <SampleBadge of={a} lm /></p>
                    </div>
                    <span className="r">{a.views30d.toLocaleString()} 阅</span>
                  </li>
                ))}
              </ol>
            </div>
            {board.length > 0 && (
              <aside className="board">
                <h3>有帮到我 <small>读者按的「有帮到我」</small></h3>
                <ol>{board.map((p) => (
                  <li key={p.id}><div><Link to={`/people/${p.id}`}><b>{p.name}</b></Link><small>{getPerson(p.id)?.title}</small></div><span>{p.helpedCount}</span></li>
                ))}</ol>
              </aside>
            )}
          </div>
        </section>

        <section className="sec snap-pt" id="section-people">
          <div className="sec-head"><span className="fish">◆</span><h2>推荐分享者</h2><p>北大邮箱认证 · 可预约</p>
            <span className="more">
              <button className="arrow" type="button" aria-label="往左" onClick={() => scrollPeople(-1)}>‹</button>
              <button className="arrow" type="button" aria-label="往右" onClick={() => scrollPeople(1)}>›</button>
              <Link to="/people">全部人物 →</Link>
            </span>
          </div>
          <div className="people">
            {PERSONS.map((p) => (
              <Link key={p.id} className="person" to={`/people/${p.id}`}>
                <div className="pcard">
                  <div className="ph"><img src={p.avatar} alt="" /><div><b>{p.name}</b><span className="sc">{[p.undergrad, p.schoolTier, p.major].filter(Boolean).join(' · ')}</span></div></div>
                  <span className="path">{p.title}</span>
                  <span className="ft">{p.reviewCount ? <>★ <b>{p.rating}</b>（{p.reviewCount} 条评价）</> : '还没有评价'}{p.consultationAvailable && ' · 可预约'} <SampleBadge of={p} lm /></span>
                  <span className="more-btn">了解更多 ›</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
