import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import { assistAvailability, deleteArticle, incomingBookings, myAvailability, setAvailability, updateProfile, uploadImage } from '../data/api';
import MonthCalendar, { thisMonth } from '../components/MonthCalendar';
import EmailCodeForm from '../components/EmailCodeForm';
import './me.css';
import { articlesByAuthor, getPerson, getWishRequest } from '../data/mock';

const ROLE_LABEL = { reader: '读者', sharer: '分享者', company: '公司' };
const input = 'lm-in';
const box = 'lm-me-box';
function ContentList({ items, label }) {
  const [gone, setGone] = useState([]); // 刚删掉的，不等父层重算就先拿掉
  const [confirm, setConfirm] = useState(null); // 按了一次「删除」的那篇，再按一次才真删
  const [err, setErr] = useState('');
  const shown = items.filter((a) => !gone.includes(a.id));
  const remove = async (id) => {
    setErr('');
    try { await deleteArticle(id); setGone([...gone, id]); } catch (e) { setErr(`删除失败：${e.message}`); }
    setConfirm(null);
  };
  return (
    <div className="lm-me-panel">
      <Link to="/write" className="lm-btn-ink lm-btn-sm" style={{ justifySelf: 'start' }}>＋ 发布新内容</Link>
      {err && <p className="lm-me-err" role="status">{err}</p>}
      {shown.length === 0 ? <p className="lm-empty">还没有发布过{label}</p> : (
        <div className="lm-blist">{shown.map((a) => (
          <div key={a.id}>
            <Link to={`/articles/${a.id}`} className="grow"><h3>{a.title}</h3><span className="m">{a.date} · {a.category} · 最近 30 天 {a.views30d} 人点击 · ★ {a.stars}</span></Link>
            <Link to={`/write?edit=${a.id}`} className="lm-mini">编辑</Link>
            {confirm === a.id ? (
              <>
                <button type="button" className="lm-del solid" onClick={() => remove(a.id)}>确定删除</button>
                <button type="button" className="lm-mini" onClick={() => setConfirm(null)}>取消</button>
              </>
            ) : <button type="button" className="lm-del" onClick={() => setConfirm(a.id)}>删除</button>}
          </div>
        ))}</div>
      )}
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

// 可预约时间：以月为单位，在月历上点日子、勾整点；已被约走的不能拿掉，过去的不能动
function AvailabilityEditor() {
  const [month, setMonth] = useState(thisMonth());
  const [slots, setSlots] = useState({}); // 'YYYY-MM-DDTHH:MM' -> 是否已被约
  const [day, setDay] = useState(null);
  const [msg, setMsg] = useState('');
  const [text, setText] = useState('');
  const [before, setBefore] = useState(null); // 日历助手预览前的时段；有值 = 正在预览
  const [ai, setAi] = useState({ busy: false, note: '', ask: '' });
  const load = (rows) => { setSlots(Object.fromEntries(rows.map((r) => [r.t, r.booked]))); setBefore(null); setAi({ busy: false, note: '', ask: '' }); };
  useEffect(() => { setDay(null); myAvailability(month).then(load); }, [month]);
  const assist = async () => {
    if (!text.trim()) return;
    setAi({ busy: true, note: '', ask: '' });
    const base = before || slots;
    const r = await assistAvailability(month, text.trim(), Object.keys(base));
    setAi({ busy: false, note: r.note, ask: r.ask });
    if (r.ask) return;
    setBefore(base);
    setSlots(Object.fromEntries(r.slots.map((t) => [t, base[t] === true])));
    const firstNew = r.slots.find((t) => !(t in base));
    if (firstNew) setDay(firstNew.slice(0, 10));
  };
  const counts = {};
  Object.keys(slots).forEach((t) => { counts[t.slice(0, 10)] = (counts[t.slice(0, 10)] || 0) + 1; });
  const now = new Date();
  const free = (t) => new Date(t) > now && !slots[t];
  const toggle = (t) => setSlots((s) => { const n = { ...s }; if (t in n) delete n[t]; else n[t] = false; return n; });
  const setDay24 = (on) => setSlots((s) => {
    const n = { ...s };
    HOURS.map((h) => `${day}T${h}`).filter(free).forEach((t) => { if (on) n[t] = false; else delete n[t]; });
    return n;
  });
  const save = async () => {
    try { load(await setAvailability(month, Object.keys(slots))); setMsg('已保存'); } catch (e) { setMsg(e.message); }
    setTimeout(() => setMsg(''), 2000);
  };

  return (
    <div className="lm-me-panel">
      <h3 className="lm-me-sub">可预约时间</h3>
      <p className="lm-me-note">点日子再勾整点，一个整点就是一个可约时段（20／40 分钟都放得下）。读者只看得到还没被约走的时段。</p>
      <div className="lm-ai">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && assist()} maxLength={200}
          placeholder="或直接说：下周一到五晚上 8 点到 11 点都可以，周三除外" aria-label="用一句话说可预约时间" />
        <button type="button" onClick={assist} disabled={ai.busy}>{ai.busy ? '理解中…' : '套用'}</button>
      </div>
      {ai.ask && <p className="lm-note">{ai.ask}</p>}
      {before && (
        <p className="lm-note">
          预览：新增 {Object.keys(slots).filter((t) => !(t in before)).length} 个、拿掉 {Object.keys(before).filter((t) => !(t in slots)).length} 个时段{ai.note && `（${ai.note}）`}。没问题按下面「确认储存」，不要就
          <button type="button" className="lm-link" style={{ marginLeft: 4, fontSize: 13 }} onClick={() => { setSlots(before); setBefore(null); }}>取消</button>
        </p>
      )}
      <MonthCalendar month={month} onMonth={setMonth} counts={counts} selected={day} onPick={setDay} countLabel=" 个" />
      {day && (
        <div className="lm-me-panel" style={{ gap: 8 }}>
          <div className="lm-me-row2"><b>{day}</b>
            <button type="button" className="lm-mini" onClick={() => setDay24(true)}>整天全选</button>
            <button type="button" className="lm-mini" onClick={() => setDay24(false)}>清空这天</button>
          </div>
          <div className="lm-hours">
            {HOURS.map((h) => {
              const t = `${day}T${h}`;
              const booked = slots[t] === true;
              const on = t in slots;
              const added = before && on && !(t in before);
              const removed = before && !on && t in before;
              const cls = booked ? 'booked' : added ? 'added' : removed ? 'removed' : undefined;
              return (
                <button key={h} type="button" className={cls} aria-pressed={on} disabled={booked || new Date(t) <= now} onClick={() => toggle(t)}>{h}{booked && ' 已约'}</button>
              );
            })}
          </div>
        </div>
      )}
      <div className="lm-me-row2">
        <button type="button" className="lm-btn-ink lm-btn-sm" onClick={save}>{before ? '确认储存' : '保存这个月的时间'}</button>
        {msg && <span className="lm-me-note">{msg}</span>}
      </div>
    </div>
  );
}

// 读者和分享者都有的项目（分享者也是读者）
function ReaderRows({ sharer = false }) {
  const { bookings } = useAppState();
  return [
    ['/library', '我的关注、推荐与收藏'],
    ...(sharer ? [] : [['/bookings', `我的预约 (${bookings.length})`]]),  // 分享者的「我约别人的」并进「预约」分页
  ].map(([to, label]) => (
    <Link key={to} to={to} className="lm-me-row">{label}<span aria-hidden="true">→</span></Link>
  ));
}

// 分享者的人物页管理：「保存」走 updateProfile，没库时只改内存
function SharerManager({ person }) {
  const [tab, setTab] = useState(null); // null = 先列出所有项目让人选
  const [p, setP] = useState(() => structuredClone(person));
  const [toast, setToast] = useState('');
  const { notifications, bookings } = useAppState();
  const articles = articlesByAuthor(person.id, 'article');
  const diaries = articlesByAuthor(person.id, 'diary');
  const invited = notifications.filter((n) => n.type === 'invited');
  // ponytail: 没有「我想看」状态，用 written 通知里的 requestId 反推我按过的；AppState 加 wishes 后换掉
  const wanted = notifications.filter((n) => n.type === 'written' && n.requestId).map((n) => getWishRequest(n.requestId)).filter(Boolean);

  const [incoming, setIncoming] = useState([]);
  useEffect(() => { incomingBookings().then(setIncoming); }, []);
  const save = async () => {
    try {
      const { saved } = await updateProfile({ ...p, price20m: Number(p.price20m) || 0, price40m: Number(p.price40m) || 0 }); // 价格框编辑时是字串
      setToast(saved ? '已保存' : '已保存（示例，未写入数据库）');
    } catch (e) { setToast(e.message); }
    setTimeout(() => setToast(''), 2000);
  };
  const setField = (k, v) => setP({ ...p, [k]: v });
  const [uploading, setUploading] = useState(false);
  const changePayQr = async (file) => {
    setUploading(true);
    try {
      const url = file ? (await uploadImage(file, 'payqr')).url : '';
      const { saved } = await updateProfile({ id: person.id, payQr: url });
      setP((x) => ({ ...x, payQr: url }));
      setToast(file ? (saved ? '收款码已更新' : '收款码已更新（示例，后端未连接）') : '已拿掉收款码');
    } catch (e) { setToast(e.message); }
    setUploading(false); setTimeout(() => setToast(''), 2500);
  };
  const setItem = (list, i, k, v) => setField(list, p[list].map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const delItem = (list, i) => setField(list, p[list].filter((_, j) => j !== i));
  // 基本资料、人生时间线并进「我的人物页」（在人物页左看右改）；别人约我的、我约别人的并成「预约」
  const tabs = [['faq', '关键问答'], ['consultation', '咨询设定'], ['bookings', `预约 (${incoming.length + bookings.length})`],
    ['articles', `经验文章管理 (${articles.length})`], ['diaries', `人物日记管理 (${diaries.length})`],
    ['wanted', `我按过的「我想看」 (${wanted.length})`], ['invited', `收到的求经验邀请 (${invited.length})`]];
  const saveBtn = <div className="lm-me-row2"><button type="button" className="lm-btn-ink lm-btn-sm" onClick={save}>保存</button></div>;

  return (
    <div className="lm-me-panel" style={{ gap: 16 }}>
      {tab === null ? (
        <div className="lm-me-list">
          <Link to={`/people/${person.id}`} className="lm-me-row"><div><b>我的人物页</b><small>基本资料、人生时间线</small></div><span aria-hidden="true">→</span></Link>
          {tabs.map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className="lm-me-row">{label}<span aria-hidden="true">→</span></button>
          ))}
          <ReaderRows sharer />
        </div>
      ) : (
        <button type="button" onClick={() => setTab(null)} className="lm-me-back">← 返回 ·<b>{tabs.find(([id]) => id === tab)[1]}</b></button>
      )}

      {tab === 'bookings' && (
        <div className="lm-me-panel">
          <h3 className="lm-me-sub">别人约我的<small>{incoming.length}</small></h3>
          {incoming.length === 0 ? <p className="lm-empty">还没有人预约你</p> : incoming.map((b) => (
            <div key={b.id} className="lm-bk">
              <span className={`st${b.status === 'done' ? ' done' : ''}`}>{b.status === 'done' ? '已完成' : b.paid ? '读者已标记付款，请到微信核对' : '待付款'}</span>
              <h3>{b.readerName}（{b.duration} 分钟）· ¥{b.price}</h3>
              <p>时段：{b.slot}</p>
              {b.question && <p style={{ whiteSpace: 'pre-wrap' }}>问题：{b.question}</p>}
              <p>下单于 {b.date}</p>
            </div>
          ))}
          <h3 className="lm-me-sub">我约别人的<small>{bookings.length}</small></h3>
          {bookings.length === 0 ? <div className="lm-empty"><span>目前尚无预约的咨询记录</span><Link className="lm-btn-ink lm-btn-sm" to="/people">去人物资料库预约 1-on-1</Link></div> : (
            <>
              {bookings.map((b) => (
                <div key={b.id} className="lm-bk">
                  <span className={`st${b.status === 'done' ? ' done' : ''}`}>{b.status === 'done' ? '已完成' : '待进行咨询'}</span>
                  <h3><Link to={`/people/${b.personId}`}>{b.mentorName}</Link>（{b.duration} 分钟）· ¥{b.price}</h3>
                  <p>{b.slot}</p>
                </div>
              ))}
              <Link to="/bookings" className="lm-link">到「我的预约」付款、完成并评价 →</Link>
            </>
          )}
        </div>
      )}

      {tab === 'faq' && (
        <div className="lm-me-panel">
          {p.faqs.map((f, i) => (
            <div key={i} className={box}>
              <div className="lm-me-row2">
                <input value={f.q} onChange={(e) => setItem('faqs', i, 'q', e.target.value)} placeholder="问题" aria-label="问题" className={input} style={{ flex: 1 }} />
                <button type="button" className="lm-del" onClick={() => delItem('faqs', i)}>删除</button>
              </div>
              <textarea value={f.a} onChange={(e) => setItem('faqs', i, 'a', e.target.value)} placeholder="回答" aria-label="回答" rows={2} className={input} />
            </div>
          ))}
          <button type="button" className="lm-addrow" onClick={() => setField('faqs', [...p.faqs, { q: '', a: '' }])}>＋ 新增问答</button>
          {saveBtn}
        </div>
      )}

      {tab === 'consultation' && (
        <div className="lm-me-panel" style={{ gap: 18 }}>
          <div className={box}>
            <label className="lm-me-sw">开放付费咨询<input type="checkbox" checked={p.consultationAvailable} onChange={(e) => setField('consultationAvailable', e.target.checked)} /></label>
            <div className="lm-me-g2">
              {[['price20m', '20 分钟价格（元）'], ['price40m', '40 分钟价格（元）']].map(([k, label]) => (
                <label key={k} className="lm-fl"><span>{label}</span><input type="number" min="0" value={p[k]} onChange={(e) => setField(k, e.target.value)} className={input} /></label>
              ))}
            </div>
            {saveBtn}
          </div>
          <AvailabilityEditor />
          <div className="lm-me-panel">
            <h3 className="lm-me-sub">微信收款码</h3>
            <p className="lm-me-note">读者预约后会看到这张码，扫码直接付给你，平台不经手；读者按「我已付款」后你会收到通知，请自己到微信核对。</p>
            <div className="lm-me-row2">
              {p.payQr ? <img className="lm-me-qr" src={p.payQr} alt="微信收款码" /> : <div className="lm-me-qr empty">还没上传</div>}
              <div style={{ display: 'grid', gap: 8 }}>
                <label className="lm-mini" style={{ cursor: 'pointer', textAlign: 'center', opacity: uploading ? 0.5 : 1, pointerEvents: uploading ? 'none' : undefined }}>
                  {uploading ? '上传中…' : p.payQr ? '更换收款码' : '上传收款码'}
                  <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { changePayQr(e.target.files[0]); e.target.value = ''; }} />
                </label>
                {p.payQr && <button type="button" className="lm-del" onClick={() => changePayQr(null)}>拿掉</button>}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'articles' && <ContentList items={articles} label="经验文章" />}
      {tab === 'diaries' && <ContentList items={diaries} label="人物日记" />}

      {tab === 'wanted' && (wanted.length === 0 ? <p className="lm-empty">还没有按过「我想看」</p> : (
        <div className="lm-blist">{wanted.map((w) => (
          <div key={w.id}>
            <div className="grow"><h3>{w.query}</h3><span className="m">{w.wantCount} 人想看 · {w.status}</span></div>
            {w.articleId && <Link to={`/articles/${w.articleId}`} className="lm-mini">去看文章</Link>}
          </div>
        ))}</div>
      ))}

      {tab === 'invited' && (invited.length === 0 ? <p className="lm-empty">还没有收到邀请</p> : (
        <div className="lm-blist">{invited.map((n) => (
          <div key={n.id}>
            <div className="grow"><h3 style={{ font: '400 15px/1.6 var(--sans)' }}>{n.text}</h3><span className="m">{n.date}</span></div>
            <Link to={n.link} className="lm-btn-ink lm-btn-sm">去写</Link>
          </div>
        ))}</div>
      ))}

      {toast && <div className="lm-toast" role="status">{toast}</div>}
    </div>
  );
}

export default function MePage() {
  const { user, logout, upgradePku } = useAppState();
  const navigate = useNavigate();
  const [pku, setPku] = useState(false); // 展开北大邮箱验证表单
  if (!user) return <Navigate to="/login" replace />;
  const person = user.role === 'sharer' && getPerson(user.personId);

  return (
    <div className="lm-me space-y-6">
      <div className="lm-me-h lm-bleed"><div className="lm-wrap">
        <div>
          <span className="lm-me-lab">我的内容管理</span>
          <h1>我的内容管理</h1>
          <p>{user.name} · {user.email} · 当前身份：{ROLE_LABEL[user.role]}</p>
        </div>
        <div className="lm-me-row2">
          {user.role === 'reader' && <button type="button" className="lm-btn-book" aria-expanded={pku} onClick={() => setPku((v) => !v)}>验证北大邮箱，升级为分享者</button>}
          <button type="button" onClick={() => { logout(); navigate('/login'); }} className="lm-btn-line">切换身份 / 退出</button>
        </div>
      </div></div>
      {pku && user.role === 'reader' && (
        <div className="lm-me-box" style={{ maxWidth: 480 }}>
          <h3 className="lm-me-sub" style={{ border: 0, paddingTop: 0 }}>验证北大邮箱</h3>
          <p className="lm-me-note">验证通过就升级为分享者：可以写经验文章、有自己的人物页、可被预约。一个北大邮箱只能验证一个账号。</p>
          <EmailCodeForm purpose="pku_verify" placeholder="xxx@pku.edu.cn 或 xxx@stu.pku.edu.cn" submitLabel="验证并升级" onSubmit={async (email, code) => { await upgradePku(email, code); setPku(false); }} />
        </div>
      )}
      {person ? <SharerManager person={person} /> : user.role === 'reader' && (
        <div className="lm-me-list"><ReaderRows /></div>
      )}
    </div>
  );
}
