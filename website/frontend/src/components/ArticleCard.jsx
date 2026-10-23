import { Link } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import { getPerson, starCount } from '../data/mock';
import SampleBadge from './SampleBadge';
import WhyBlock, { MatchLight } from './WhyBlock';

// 文章卡（新设计）：分类朱砂小字、结果小签、宋体标题、摘要三行；推荐／收藏照原本（访客点了跳登录，AppState 里挡）
// why（可选）：「AI 帮我选」的推荐理由
export default function ArticleCard({ article, why }) {
  const { starred, bookmarked, toggleStar, toggleBookmark } = useAppState();
  const author = getPerson(article.authorId);
  const outcome = article.decisionPoint?.结果;
  return (
    <article className="lm-ac">
      <div className="lm-ac-m">
        <span className="c">{article.type === 'diary' ? `人物日记 · ${article.category}` : article.category}</span>
        {['成功', '失败', '转向'].includes(outcome) && <span className={`lm-oc lm-oc-${outcome}`}>{outcome}</span>}
        <SampleBadge of={article} lm />
        <MatchLight level={why?.match} />
        <span className="v">{article.views30d} 阅 · {article.readTime}</span>
      </div>
      <h3><Link to={`/articles/${article.id}`}>{article.title}</Link></h3>
      <p>{article.summary}</p>
      <WhyBlock w={why} />
      <div className="lm-ac-f">
        <Link to={`/people/${article.authorId}`}><img src={author?.avatar} alt="" /><span>{author?.name}</span></Link>
        <div>
          <button type="button" aria-pressed={!!starred[article.id]} onClick={() => toggleStar(article.id)}>{starred[article.id] ? '★' : '☆'} {starCount(article, starred)}</button>
          <button type="button" aria-pressed={!!bookmarked[article.id]} onClick={() => toggleBookmark(article.id)}>{bookmarked[article.id] ? '已收藏' : '收藏'}</button>
        </div>
      </div>
    </article>
  );
}
