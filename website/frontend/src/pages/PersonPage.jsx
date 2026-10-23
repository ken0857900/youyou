import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import { articlesByAuthor, getPerson } from '../data/mock';
import { personStats, updateProfile, uploadImage } from '../data/api';
import BookingModal from '../components/BookingModal';
import ShareCardModal from '../components/ShareCardModal';
import SampleBadge from '../components/SampleBadge';
import NotFoundPage from './NotFoundPage';
import { BackButton } from './ArticlePage';
import './person.css';

// 人物页（新设计）＋作者本人「编辑我的页面」：左边是读者看到的样子（即时更新），右边是编辑表单
// 存档用 Ken 原本的 updateProfile（PATCH /api/me/profile），字段跟「我的」基本资料同一组
const FIELDS = [['name', '显示名称'], ['title', '头衔（例：双非统计学 → 推免光华金融硕士）'], ['tagline', '一句话摘要'], ['school', '学校'], ['major', '专业'], ['gradYear', '毕业年'], ['city', '所在城市']];
const KEYS = [...FIELDS.map(([k]) => k), 'timeline'];  // 关键问答、咨询设定只在「我的」改（Ken 10/21 决定）
// 删除头像后的预设头像：跟示例资料同一种方块字头像（后端只收自己上传的图或这种内建字母头像）
const plainAvatar = (name) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#8a8174"/><text x="32" y="42" font-family="system-ui,sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${[...(name || '?').trim()][0] || '?'}</text></svg>`);
const isPlain = (a) => !a || a.startsWith(plainAvatar('?').split('%3Ctext')[0]);  // 已经是预设头像就不显示「删除」
const newest = (p) => p.timeline.map((_, i) => i).reverse();  // 人生时间线：最近的在上面
const s = (v) => String(v ?? '').trim();

function Sec({ title, hint, children }) {
  return (
    <section className="sec">
      <div className="sec-head"><span className="fish">◆</span><h2>{title}</h2>{hint && <p>{hint}</p>}</div>
      {children}
    </section>
  );
}
function Posts({ items, empty }) {
  if (!items.length) return <p className="empty">{empty}</p>;
  return (
    <div className="posts">
      {items.map((a) => (
        <Link key={a.id} className="post" to={`/articles/${a.id}`}>
          <span className="m"><b>{a.category}</b>{a.date}</span><h3>{a.title}</h3><p>{a.summary}</p>
        </Link>
      ))}
    </div>
  );
}

// 整页：抬头＋各区块。一般浏览和编辑时左栏的预览都用这一个，预览＝读者真的看到的
function Profile({ p, stats, owner, preview, following, onFollow, onCard, onBook, onEdit }) {
  const meta = [p.school, p.gradYear, p.city].filter((x) => s(x)).join(' · ');
  return (
    <>
      <section className="ph lm-bleed"><div className="lm-wrap">
        {!preview && <BackButton fallback="/people" />}
        <div className="ph-main">
          <img className="seal-av lm-seal-av" src={p.avatar || plainAvatar(p.name)} alt={p.name} />
          <div className="ph-info">
            <div className="ph-name"><h1>{p.name}</h1><SampleBadge of={p} lm />{p.verified && <span className="ver">✓ 北大认证</span>}</div>
            {s(p.title) && <p className="ph-title">{p.title}</p>}
            <p className="ph-meta">{meta}</p>
            <p className="ph-meta">本科：{p.undergrad}（{p.schoolTier}）{s(p.major) && ` · ${p.major}`}</p>
            {s(p.tagline) && <p className="ph-tag">{p.tagline}</p>}
            {stats && (
              <p className="ph-stats">
                <span title="觉得 TA 的文章有帮助的不同读者人数">文章累计帮到<b>{stats.helpedCount}</b>人</span>
                {stats.ratingCount > 0 && <span>咨询<b className="star">★ {stats.ratingAvg}</b>（{stats.ratingCount} 条评价）</span>}
              </p>
            )}
          </div>
          <div className="ph-act">
            {owner ? (
              <>
                <button className="lm-btn-ink" type="button" onClick={onEdit}>✎ 编辑我的页面</button>
                <button className="lm-btn-line" type="button" onClick={onCard}>经历名片</button>
              </>
            ) : (
              <>
                <button className={`lm-btn-ink${following ? ' on' : ''}`} type="button" aria-pressed={!!following} onClick={onFollow}>{following ? '已关注' : '＋ 关注'}</button>
                <button className="lm-btn-line" type="button" onClick={onCard}>经历名片</button>
                {p.consultationAvailable && <button className="lm-btn-book" type="button" onClick={onBook}>预约 1 对 1 咨询</button>}
              </>
            )}
          </div>
        </div>
      </div></section>
      <div className="lm-wrap pb">
        <Sec title="人生时间线" hint="作者自己填写的每个关键阶段">
          {p.timeline.length ? (
            <ol className="tl">{newest(p).map((i) => { const t = p.timeline[i]; return <li key={i}><span className="y">{t.year}</span><b>{t.title}</b><p>{t.desc}</p></li>; })}</ol>
          ) : <p className="empty">还没有填写人生时间线。</p>}
        </Sec>
        <Sec title="经验文章" hint="实用内容：怎么做、怎么判断"><Posts items={articlesByAuthor(p.id, 'article')} empty="这位还没有发布经验文章。" /></Sec>
        <Sec title="人物日记" hint="分享日常：现在正在经历什么"><Posts items={articlesByAuthor(p.id, 'diary')} empty="这位还没有发布日记。" /></Sec>
        {stats?.recentReviews.length > 0 && (
          <Sec title="咨询评价" hint="读者评的是这次咨询有没有帮到自己">
            <div className="rv-list">{stats.recentReviews.map((r, i) => (
              <div key={i} className="rv-i"><span className="s">{'★'.repeat(r.stars)}{'☆'.repeat(5 - r.stars)}</span><b>{r.name}</b><small>{r.date}</small>{r.comment && <p>{r.comment}</p>}</div>
            ))}</div>
          </Sec>
        )}
        {p.faqs.length > 0 && (
          <Sec title="关键问答">
            <dl className="faq">{p.faqs.map((f, i) => <div key={i}><dt>{f.q}</dt><dd>{f.a}</dd></div>)}</dl>
          </Sec>
        )}
      </div>
    </>
  );
}

// 编辑表单（右栏）：每个能改的都有「删除」——一般栏位删除＝清空，时间线删除＝拿掉这一条，头像删除＝换回预设头像
function EditForm({ D, bad, uploading, set, setItem, add, rm, clear, onAvatar }) {
  const del = (what, onClick) => <button type="button" className="rm" aria-label={`删除${what}`} onClick={onClick}>删除</button>;
  const field = (k, l, ctl) => (
    <div className="fl" key={k}><div className="fl-h"><label htmlFor={`f-${k}`}>{l}</label>{del(l.replace(/（.*）/, ''), () => clear(k))}</div>{ctl}</div>
  );
  const cls = (k) => `in${bad.includes(k) ? ' bad' : ''}`;
  return (
    <div className="sp-form">
      <section>
        <h2 className="sp-h">基本资料</h2>
        <div className="av-pick">
          <img src={D.avatar || plainAvatar(D.name)} alt="" />
          <label className="mini">{uploading ? '上传中…' : '更换头像'}<input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={uploading} onChange={(e) => { onAvatar(e.target.files[0]); e.target.value = ''; }} /></label>
          {!isPlain(D.avatar) && del('头像', () => clear('avatar'))}
        </div>
        {FIELDS.map(([k, l]) => field(k, l, k === 'tagline'
          ? <textarea className={cls(k)} rows={2} id={`f-${k}`} data-f={k} value={D[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
          : <input className={cls(k)} id={`f-${k}`} data-f={k} value={D[k] ?? ''} onChange={(e) => set(k, e.target.value)} />))}
      </section>
      <section>
        <h2 className="sp-h">人生时间线<small>最近的放最上面</small></h2>
        <button type="button" className="addrow" onClick={() => add('timeline')}>＋ 新增一段经历</button>
        {newest(D).map((i) => { const t = D.timeline[i]; return (
          <div key={i} className="sp-item">
            <div className="sp-row">
              <input className="in" style={{ flex: 'none', width: '6.5em' }} data-l="timeline" data-i={i} data-k="year" placeholder="年份" aria-label="年份" value={t.year} onChange={(e) => setItem('timeline', i, 'year', e.target.value)} />
              <input className="in" placeholder="这段经历的标题" aria-label="标题" value={t.title} onChange={(e) => setItem('timeline', i, 'title', e.target.value)} />
              {del('这段经历', () => rm('timeline', i))}
            </div>
            <textarea className="in" rows={2} placeholder="说说这段经历" aria-label="描述" value={t.desc} onChange={(e) => setItem('timeline', i, 'desc', e.target.value)} />
          </div>
        ); })}
      </section>
      <p className="cs-note">关键问答、咨询设定（开放咨询、价格、可预约时间、收款码）在<Link to="/me">「我的」</Link>设定</p>
    </div>
  );
}

export default function PersonPage() {
  const { id } = useParams();
  const person = getPerson(id);
  const { user, following, toggleFollow } = useAppState();
  const owner = !!person && !!user?.personId && user.personId === person.id;  // 作者本人＝登录的分享者看自己的页
  const [modal, setModal] = useState(null); // 'booking' | 'card' | null
  const [stats, setStats] = useState(null);
  const [D, setD] = useState(null);  // 编辑中的草稿（null＝没在编辑）
  const [ui, setUi] = useState({ dirty: false, asking: false, view: 'form', bad: [], uploading: false });
  const [toast, setToast] = useState('');
  useEffect(() => { personStats(id).then(setStats); }, [id]);
  useEffect(() => { setD(null); }, [id]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 2400); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { if (D) window.scrollTo(0, 0); }, [D === null]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!person) return <NotFoundPage />;

  const edit = (fn) => { setD((d) => fn(structuredClone(d))); setUi((u) => ({ ...u, dirty: true, bad: [] })); };
  const set = (k, v) => edit((d) => { d[k] = v; return d; });
  const setItem = (l, i, k, v) => edit((d) => { d[l][i][k] = v; return d; });
  const focusLater = (sel) => setTimeout(() => document.querySelector(sel)?.focus(), 0);
  const add = (l) => { edit((d) => { d[l].push({ year: '', title: '', desc: '' }); return d; }); focusLater(`[data-l="${l}"][data-i="${D[l].length}"]`); };
  const rm = (l, i) => edit((d) => { d[l].splice(i, 1); return d; });
  const clear = (k) => { edit((d) => { d[k] = k === 'avatar' ? plainAvatar(d.name) : ''; return d; }); if (k !== 'avatar') focusLater(`[data-f="${k}"]`); };
  const onAvatar = async (file) => {
    if (!file) return;
    setUi((u) => ({ ...u, uploading: true }));
    try {
      const { url, saved } = await uploadImage(file, 'avatar');
      edit((d) => { d.avatar = url; return d; });
      setToast(saved ? '头像已上传，按「保存」后生效' : '头像已更新（示例，后端未连接，刷新后消失）');
    } catch (e) { setToast(e.message); }
    setUi((u) => ({ ...u, uploading: false }));
  };
  const startEdit = () => {
    setD(structuredClone(person));
    setUi({ dirty: false, asking: false, view: 'form', bad: [], uploading: false });
    focusLater('[data-f="name"]');
  };
  const exitEdit = () => { setD(null); focusLater('.lm-pp .ph-act .lm-btn-ink'); };
  // 保存：显示名称不能空；空白的时间线略过
  const save = async () => {
    if (!s(D.name)) {
      setUi((u) => ({ ...u, bad: ['name'], asking: false, view: 'form' }));
      focusLater('[data-f="name"]');
      return setToast('显示名称不能空着');
    }
    const clean = { ...Object.fromEntries(KEYS.map((k) => [k, D[k]])), name: s(D.name), timeline: D.timeline.filter((t) => s(t.year) || s(t.title) || s(t.desc)) };
    if (D.avatar !== person.avatar) clean.avatar = D.avatar || plainAvatar(clean.name);  // 头像有换才送（后端只收上传的图或字母头像）
    try {
      const { saved } = await updateProfile({ id: person.id, ...clean });
      exitEdit();
      setToast(saved ? '已保存' : '已保存（示例，未写入数据库）');
    } catch (e) { setToast(e.message || '保存失败，请再试一次'); }
  };

  const profileProps = { stats, following: following[person.id], onFollow: () => toggleFollow(person.id), onCard: () => setModal('card'), onBook: () => setModal('booking'), onEdit: startEdit };
  const modals = (
    <>
      {modal === 'booking' && <BookingModal person={person} onClose={() => setModal(null)} />}
      {modal === 'card' && <ShareCardModal person={person} onClose={() => setModal(null)} />}
      {toast && <div className="lm-toast" role="status">{toast}</div>}
    </>
  );

  if (!D) return <div className="lm-pp"><Profile p={person} owner={owner} {...profileProps} />{modals}</div>;

  return (
    <div className="lm-pp">
      <div className="ebar lm-bleed" role="region" aria-label="编辑列"><div className="lm-wrap">
        <p>✎ 正在编辑你的人物页<small>左边即时显示读者看到的样子</small></p>
        <div className="eb">
          {ui.asking ? (
            <><span className="eb-ask">放弃这次修改？</span>
              <button type="button" onClick={() => setUi((u) => ({ ...u, asking: false }))}>继续编辑</button>
              <button type="button" className="eb-save" onClick={exitEdit}>放弃</button></>
          ) : (
            <><button type="button" onClick={() => (ui.dirty ? setUi((u) => ({ ...u, asking: true })) : exitEdit())}>取消</button>
              <button type="button" className="eb-save" onClick={save}>保存</button></>
          )}
        </div>
      </div></div>
      <div className="lm-wrap sp" data-view={ui.view}>
        <div className="sp-tabs">{[['prev', '预览'], ['form', '编辑']].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={ui.view === k} onClick={() => setUi((u) => ({ ...u, view: k }))}>{l}</button>
        ))}</div>
        <div className="sp-prev">
          <p className="sp-lab">读者看到的样子 · 即时更新</p>
          <div className="sp-frame" inert><Profile p={D} preview {...profileProps} /></div>
        </div>
        <EditForm D={D} bad={ui.bad} uploading={ui.uploading} set={set} setItem={setItem} add={add} rm={rm} clear={clear} onAvatar={onAvatar} />
      </div>
      {modals}
    </div>
  );
}

