import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import { assistSlots, personSlots } from '../data/api';
import MonthCalendar, { thisMonth } from './MonthCalendar';
import useModal from './useModal';

const PERIODS = [['凌晨', 0, 6], ['上午', 6, 12], ['下午', 12, 18], ['晚上', 18, 24]];
const label = (t) => `${t.slice(0, 10)}（周${'日一二三四五六'[new Date(t).getDay()]}）${t.slice(11)}`;

// 预约弹窗：<BookingModal person={p} onClose={...} />；未登录时一打开就提示登录，免得填完表单才被跳走
export default function BookingModal({ person, onClose }) {
  const { user, addBooking } = useAppState();
  const box = useModal(onClose);
  const navigate = useNavigate();
  const [duration, setDuration] = useState(20);
  const [question, setQuestion] = useState('');
  const [month, setMonth] = useState(thisMonth());
  const [slots, setSlots] = useState(null); // 这个月还能约的时段；null = 读取中
  const [day, setDay] = useState(null);
  const [startsAt, setStartsAt] = useState(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [ai, setAi] = useState(null); // { busy } 或日历助手回的 { matches, note, ask }
  const price = duration === 20 ? person.price20m : person.price40m;
  const reload = () => personSlots(person.id, month).then(setSlots);
  useEffect(() => { setSlots(null); setDay(null); setStartsAt(null); setAi(null); if (user) reload(); }, [person.id, month, user]); // eslint-disable-line react-hooks/exhaustive-deps
  const assist = async () => {
    if (!text.trim()) return;
    setAi({ busy: true });
    const r = await assistSlots(person.id, month, text.trim());
    setAi(r);
    if (r.matches?.length) { setDay(r.matches[0].slice(0, 10)); setStartsAt(null); }
  };
  const match = new Set(ai?.matches || []);
  const counts = {};
  (slots || []).forEach((t) => { counts[t.slice(0, 10)] = (counts[t.slice(0, 10)] || 0) + 1; });

  const confirm = async () => {
    if (!startsAt) return;
    try {
      await addBooking({ personId: person.id, mentorName: person.name, duration, startsAt, slot: label(startsAt), price, question: question || '想聊聊我的升学/求职选择' });
      onClose();
      navigate('/bookings');
    } catch {
      setErr('这个时段刚被约走了，请换一个'); setStartsAt(null); reload();
    }
  };

  if (!user) {
    return (
      <div className="lm-modal">
        <div className="lm-modal-scrim" onClick={onClose} />
        <div ref={box} className="lm-modal-box sm" role="dialog" aria-modal="true" aria-labelledby="lm-bk-t">
          <h3 id="lm-bk-t">登录后预约</h3>
          <p>预约 {person.name} 的一对一咨询需要先登录。</p>
          <div className="row2">
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" onClick={() => { onClose(); navigate('/login'); }}>去登录</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lm-modal">
      <div className="lm-modal-scrim" onClick={onClose} />
      {/* 内容比屏幕高时弹窗自己卷动；确认按钮钉在底部 */}
      <div ref={box} className="lm-modal-box" role="dialog" aria-modal="true" aria-labelledby="lm-bk-t">
        <button type="button" className="lm-x" onClick={onClose} aria-label="关闭"><i /><i /></button>
        <div className="lm-bk-h"><h3 id="lm-bk-t">预约一对一咨询</h3><p className="sub">分享者：{person.name}</p></div>
        <div className="lm-bk-s">
          <span>一、选择咨询时长</span>
          <div className="lm-opts">
            {[20, 40].map((d) => (
              <button key={d} type="button" className="lm-opt" aria-pressed={duration === d} onClick={() => setDuration(d)}>
                <b>{d === 20 ? '20 分钟经验咨询' : '40 分钟深度规划'}</b><small>¥ {d === 20 ? person.price20m : person.price40m}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="lm-bk-s">
          <span>二、选择时间（北京时间）</span>
          <div className="lm-ai">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && assist()} maxLength={200} placeholder="说说你什么时候有空，例：下周末下午" aria-label="你什么时候有空" />
            <button type="button" onClick={assist} disabled={ai?.busy}>{ai?.busy ? '找中…' : '帮我找'}</button>
          </div>
          {ai && !ai.busy && (ai.ask ? <p className="lm-note">{ai.ask}</p>
            : <p className="lm-note">{ai.matches.length ? `找到 ${ai.matches.length} 个跟你时间对得上的时段，已用 ★ 标出` : '这个月没有跟你时间对得上的时段，看看其他时间或下个月'}{ai.note && `（${ai.note}）`}</p>)}
          <MonthCalendar month={month} onMonth={setMonth} counts={counts} selected={day} onPick={(d) => { setDay(d); setStartsAt(null); setErr(''); }} countLabel=" 个" />
          {slots && slots.length === 0 && <p className="muted">这个月还没有可约时间，看看下个月</p>}
          {day && (
            <div className="lm-slots">
              {PERIODS.map(([name, from, to]) => {
                const list = (slots || []).filter((t) => t.startsWith(day) && +t.slice(11, 13) >= from && +t.slice(11, 13) < to);
                return list.length > 0 && (
                  <div key={name}><span>{name}</span><div className="l">
                    {list.map((t) => (
                      <button key={t} type="button" className={match.has(t) ? 'match' : undefined} aria-pressed={startsAt === t} onClick={() => { setStartsAt(t); setErr(''); }}>{match.has(t) && '★'}{t.slice(11)}</button>
                    ))}
                  </div></div>
                );
              })}
              {!counts[day] && <p className="muted">这天没有可约时间</p>}
            </div>
          )}
          {err && <p className="err" role="status">{err}</p>}
        </div>
        <div className="lm-bk-s" style={{ borderBottom: 0 }}>
          <span>三、想问的问题</span>
          <textarea className="lm-in" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="说说你的背景（学校、专业、年级）和最想讨论的问题…" aria-label="想问的问题" />
        </div>
        <div className="lm-bk-go">
          <button type="button" onClick={confirm} disabled={!startsAt}>{startsAt ? `确认预约 ${label(startsAt)}（¥ ${price}）` : '先选一个时间'}</button>
        </div>
      </div>
    </div>
  );
}
