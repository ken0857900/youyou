import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import PageHead from '../components/PageHead';

const Stars = ({ n }) => <span className="lm-stars"><span>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span></span>;

// 参赛版没金流/视频：读者自己按〔完成并评价〕把预约标成已完成（05 评价机制）
function ReviewForm({ booking, onDone }) {
  const { completeReview } = useAppState();
  const [stars, setStars] = useState(5);
  const [comment, setComment] = useState('');
  return (
    <div style={{ display: 'grid', gap: 8, paddingTop: 8 }}>
      <p>这次咨询对你有没有帮助？</p>
      <div className="lm-stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-label={`${n} 星`} aria-pressed={n <= stars} className={n <= stars ? 'on' : undefined} onClick={() => setStars(n)}>★</button>
        ))}
      </div>
      <textarea className="lm-in" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} rows={2} placeholder="选填：哪里帮到你了？" aria-label="评价" />
      <button type="button" className="lm-btn-ink lm-btn-sm" style={{ justifySelf: 'start' }} onClick={async () => { await completeReview(booking, stars, comment.trim()); onDone(); }}>提交评价</button>
    </div>
  );
}

// 平台不经手钱：显示分享者自己的微信收款码，读者付完按一下，分享者收到通知后自己去微信核对
function PayBox({ booking }) {
  const { markPaid } = useAppState();
  if (booking.paid) return <p className="ok">✓ 已标记付款，等分享者在微信核对</p>;
  if (!booking.price) return null;
  if (!booking.payQr) return <p>分享者还没上传收款码，咨询前请跟他确认付款方式</p>;
  return (
    <div className="row">
      <img className="qr" src={booking.payQr} alt="微信收款码" />
      <div style={{ display: 'grid', gap: 8 }}>
        <p>用微信扫码付 ¥{booking.price}<br />付款备注写预约时间，方便对方核对</p>
        <button type="button" className="lm-btn-book lm-btn-sm" style={{ justifySelf: 'start' }} onClick={() => markPaid(booking)}>我已付款</button>
      </div>
    </div>
  );
}

export default function BookingsPage() {
  const { user, bookings } = useAppState();
  const [reviewing, setReviewing] = useState(null);
  if (!user) return <Navigate to="/login" replace />;
  return (
    <div className="lm-pg">
      <PageHead label={<>我的<em>预约</em></>} title="我的咨询预约记录" />
      <div className="lm-wrap lm-narrow">
        {bookings.length === 0 ? (
          <div className="lm-empty"><span>目前尚无预约的咨询记录</span><Link className="lm-btn-ink" to="/people">去人物资料库预约 1-on-1</Link></div>
        ) : bookings.map((b) => (
          <div key={b.id} className="lm-bk">
            <span className={`st${b.status === 'done' ? ' done' : ''}`}>{b.status === 'done' ? '已完成' : '预约成功 · 待进行咨询'}</span>
            <h3><Link to={`/people/${b.personId}`}>{b.mentorName}</Link>（{b.duration} 分钟）· ¥{b.price}</h3>
            <p>预约时间：{b.slot}</p>
            <p>咨询问题：{b.question}</p>
            {b.status !== 'done' && <PayBox booking={b} />}
            {b.review && <p>我的评价：<Stars n={b.review.stars} /> {b.review.comment}</p>}
            {reviewing === b.id && <ReviewForm booking={b} onDone={() => setReviewing(null)} />}
            {b.status !== 'done' && reviewing !== b.id && (
              <button type="button" className="lm-btn-line lm-btn-sm" style={{ justifySelf: 'start', marginTop: 4 }} onClick={() => setReviewing(b.id)}>完成并评价</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
