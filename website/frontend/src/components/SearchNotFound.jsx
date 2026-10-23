import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CATEGORIES, WISH_REQUESTS, getPerson } from '../data/mock';
import { createWish } from '../data/api';
import { closest, removalCounts } from '../data/mockSearch';
import { useAppState } from '../context/AppState';

const WISH_NOTIFY_AT = 5; // 跟后端 agents.WISH_NOTIFY_AT 一致

// 找不到结果（docs/05）：A 拿掉一个条件 / B 最接近的经验 / C 分类入口 / D 我想看；无关问题只显示 C
// guess：有召回、但红绿灯没有一篇红或黄 → 下面另列「猜你想看」字卡，这里就不放 A、B
export default function SearchNotFound({ q, parsed, filters, onApply, irrelevant, guess }) {
  const navigate = useNavigate();
  const { user } = useAppState();
  const [wish, setWish] = useState(null); // 按过「我想看」后的求经验单

  const categories = (
    <div>
      <h3>或从这里开始逛</h3>
      <div className="row">{CATEGORIES.map((c) => <Link key={c.id} className="pill" to={`/topics?cat=${c.id}`}>{c.name}</Link>)}</div>
    </div>
  );

  if (irrelevant) {
    return (
      <div className="lm-nf">
        <p className="lm-nf-msg">「{q}」看起来跟升学、求职的决定无关，这里只有北大同学的决策经验。</p>
        {categories}
      </div>
    );
  }

  const removals = guess ? [] : removalCounts(parsed, filters);
  const near = guess ? [] : closest(filters);
  const existing = WISH_REQUESTS.find((w) => w.query === q);
  const answered = existing?.articleId; // 求经验单已经有人写了
  const wantCount = (wish || existing)?.wantCount || 0;
  const want = async () => {
    if (!user) return navigate('/login');
    try { setWish({ ...(await createWish(q, filters)) }); } catch (e) { alert(e.message); }
  };

  return (
    <div className="lm-nf">
      {answered && <button type="button" className="answered" onClick={() => navigate(`/articles/${answered}`)}>✓ 已有人写了你想看的经验 → 看文章</button>}
      <h2>目前还没有人分享过「{q || '这些条件'}」这样的经验</h2>
      {removals.length > 0 && (
        <div>
          <h3>试试拿掉一个条件</h3>
          <div className="row">{removals.map((r) => (
            <button key={`${r.field}-${r.value}`} type="button" className="pill" onClick={() => onApply(r.next)}>✕ {r.value} → <b>{r.count} 人</b></button>
          ))}</div>
        </div>
      )}
      {near.length > 0 && (
        <div>
          <h3>最接近的经验（相关度较低）</h3>
          <div className="near">{near.map(({ article, diffs }) => {
            const p = getPerson(article.authorId);
            const dp = article.decisionPoint;
            return (
              <Link key={article.id} to={`/articles/${article.id}`}>
                <img src={p.avatar} alt="" />
                <div><p><b>{p.name}｜{dp.学校层级}{dp.专业} → {dp.最后的选择}（{dp.结果}）</b></p><p>跟你的差别：{diffs.join('；') || '无'}</p></div>
              </Link>
            );
          })}</div>
        </div>
      )}
      {categories}
      {!answered && (
        <div className="wish">
          {wish ? (
            <span className="done">{wish.wantCount >= WISH_NOTIFY_AT ? `✓ 已满 ${WISH_NOTIFY_AT} 人，已邀请处境最接近的 5 位分享者` : `✓ 已记下，满 ${WISH_NOTIFY_AT} 人会邀请分享者来写`}，有人写了会在站内通知你</span>
          ) : <button type="button" onClick={want}>我想看这类经验</button>}
          <span>{wantCount ? `已有 ${wantCount} 人想知道` : '还没有人提过，做第一个'}{!user && '（需登录）'}</span>
        </div>
      )}
    </div>
  );
}
