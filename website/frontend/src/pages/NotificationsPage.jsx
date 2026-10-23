import { Link, Navigate } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import PageHead from '../components/PageHead';

// 通知（新设计）：书目式清单，类型用一个小方印字，未读朱砂圆点
const TYPES = { invited: ['有人想看你写', '写'], written: ['你想看的有人写了', '文'], paid: ['读者已标记付款', '款'] };

export default function NotificationsPage() {
  const { user, notifications, markRead, markAllRead, unreadCount } = useAppState();
  if (!user) return <Navigate to="/login" replace />;
  const list = [...notifications].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="lm-pg">
      <PageHead label={<>站内<em>通知</em></>} title="通知">
        {unreadCount > 0 && <button type="button" className="lm-link" onClick={markAllRead}>全部标为已读</button>}
      </PageHead>
      <div className="lm-wrap lm-narrow">
        {list.length === 0 ? <p className="lm-empty">还没有通知</p> : (
          <div className="lm-blist lm-nt">
            {list.map((n) => {
              const [label, ic] = TYPES[n.type] || TYPES.written;
              return (
                <Link key={n.id} to={n.link} onClick={() => markRead(n.id)} className={n.read ? undefined : 'unread'}>
                  <span className={`ic ${n.type}`} aria-hidden="true">{ic}</span>
                  <div className="grow"><span className="m">{label} · {n.date}</span><p>{n.text}</p></div>
                  {!n.read && <span className="dot" title="未读" />}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
