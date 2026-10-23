import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { leaderboard } from '../data/api';

// 首页＋人物资料库共用：按「文章累计帮到多少不同读者」排，不是按名气
export default function HelpfulBoard() {
  const [rows, setRows] = useState([]);
  useEffect(() => { leaderboard(5).then(setRows); }, []);
  if (!rows.length) return null;
  return (
    <div className="lm-hb">
      <div className="lm-hb-h"><h2>最有帮助的分享者</h2><span>按文章累计帮到的读者人数</span></div>
      <ol>{rows.map((p, i) => <li key={p.id}><Link to={`/people/${p.id}`}><b>{i + 1}</b>{p.name}<small>帮到 {p.helpedCount} 人</small></Link></li>)}</ol>
    </div>
  );
}
