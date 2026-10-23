import { useRef, useState } from 'react';
import { parseFilters, pickWhy } from '../data/api';
import { MatchLegend } from './WhyBlock';

// 「用说的」：一句话交给大模型拆成 决策类型／学校层级／专业／结果，再向量召回匹配文章；
// onResult(filters, results)：results＝按匹配先后的文章 id（没后端为 null，页面就只套 filters）
// onText（可选）：每打一个字回调，人物页拿来顺便搜姓名
// onWhy（可选）：有 AI 匹配结果时再要推荐理由（另一个请求，筛选先出来），回 { 文章 id: {why, unique, quotes} }
export default function AskFilter({ placeholder, onResult, onText, onWhy }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [lit, setLit] = useState(false); // 这次有 AI 匹配结果 → 显示红绿灯图例
  const seq = useRef(0); // 理由回来时已经又问了别的：丢掉旧的

  const ask = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setNote(''); setLit(false);
    try {
      const { filters, irrelevant, results: r } = await parseFilters(text.trim());
      const results = r?.length ? r : null; // 召回 0 篇当没给，页面只套 filters
      const picked = Object.values(filters).flat();
      if (irrelevant || (picked.length === 0 && !results?.length)) setNote('没听出想看哪类经验，换个说法试试，例：没拿到光华优营的');
      else {
        onResult(filters, results);
        const base = [picked.length && `已帮你选：${picked.join(' · ')}`, results && `AI 匹配到 ${results.length} 篇相关经验`].filter(Boolean).join('；');
        setNote(base);
        if (results && onWhy) {
          setLit(true);
          const n = ++seq.current;
          onWhy({});
          setNote(`${base}；AI 正在写推荐理由…`);
          pickWhy(text.trim()).then((why) => {
            if (n !== seq.current) return;
            onWhy(why);
            const k = Object.keys(why).length;
            setNote(k ? `${base}；${k} 篇附上了推荐理由` : base);
          }).catch(() => { if (n === seq.current) setNote(base); });
        }
      }
    } catch (err) { setNote(`没解析成功：${err.message}`); }
    setBusy(false);
  };

  return (
    <form onSubmit={ask} className="lm-ask">
      <div>
        <input value={text} onChange={(e) => { setText(e.target.value); onText?.(e.target.value); }} placeholder={placeholder} maxLength={200} aria-label={placeholder} />
        <button disabled={busy || !text.trim()}>{busy ? 'AI 理解中…' : 'AI 帮我选'}</button>
      </div>
      {note && <p role="status">{note}</p>}
      {lit && <MatchLegend />}
    </form>
  );
}
