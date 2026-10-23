import { Link } from 'react-router-dom';
import { getPerson } from '../data/mock';
import WhyBlock, { MatchLight } from './WhyBlock';

// 热门排行单栏（经验文章、人物日记各一栏），items 已按 views30d 排好；前三名朱砂
// why（可选）：「AI 帮我选」的推荐理由，{ 文章 id: {why, unique, quotes} }
export default function TrendingColumn({ label, items, why = {} }) {
  if (items.length === 0) return <p className="lm-empty">还没有{label}</p>;
  return (
    <ol className="lm-rank">
      {items.map((item, idx) => (
        <li key={item.id}>
          <Link to={`/articles/${item.id}`}>
            <span className="n">{idx + 1}</span>
            <div style={{ minWidth: 0 }}><span className="m">{getPerson(item.authorId)?.name} · {item.category}<MatchLight level={why[item.id]?.match} /></span><h3>{item.title}</h3></div>
            <span className="r" title="最近 30 天阅读人数">{item.views30d} 阅</span>
          </Link>
          <WhyBlock w={why[item.id]} />
        </li>
      ))}
    </ol>
  );
}
