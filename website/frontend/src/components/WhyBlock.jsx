// 「AI 帮我选」的推荐理由（后端 07 #11）：为什么是他／独有的点／原话，标题和理由同一行；匹配度红绿灯 MatchLight 放在作者那一行
// 红绿灯照 Ken 定的：红＝很匹配、黄＝一般、绿＝可能会想看；卡片上只放一颗圆点，意思写在搜索框下面的图例（MatchLegend）
const LIGHTS = [['high', '很匹配'], ['mid', '一般'], ['low', '可能会想看']];

// 排序用：红灯在前、再黄、再绿，没理由的最后；sort 是稳定的，同一种灯维持原本顺序
export const matchRank = (w) => { const i = LIGHTS.findIndex(([k]) => k === w?.match); return i < 0 ? LIGHTS.length : i; };

export function MatchLight({ level }) {
  const label = LIGHTS.find(([k]) => k === level)?.[1];
  if (!label) return null;
  return (
    <span className={`lm-light ${level}`} role="img" aria-label={`AI 判断的匹配度：${label}`} title={`AI 判断的匹配度：${label}`} />
  );
}

export function MatchLegend() {
  return <span className="lm-legend" aria-hidden="true">{LIGHTS.map(([k, label]) => <span key={k}><i className={`lm-light ${k}`} />{label}</span>)}</span>;
}

export default function WhyBlock({ w }) {
  if (!w) return null;
  return (
    <div className="lm-why">
      <div className="pair">{/* 为什么是他｜独有的点 并排，窄屏才上下 */}
        <p><b>为什么是他</b>{w.why}</p>
        {w.unique && w.unique !== '无' && <p className="diff"><b>独有的点</b>{w.unique}</p>}
      </div>
      {w.quotes?.[0] && <blockquote>「{w.quotes[0]}」</blockquote>}
    </div>
  );
}
