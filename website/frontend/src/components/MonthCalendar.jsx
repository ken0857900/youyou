// 月历：month = 'YYYY-MM'；counts = { 'YYYY-MM-DD': 数字 } 在格子上显示；过去的日子不能点
export const ymd = (d) => d.toLocaleDateString('sv-SE'); // 本地日期 YYYY-MM-DD
export const thisMonth = () => ymd(new Date()).slice(0, 7);
export const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  return ymd(new Date(y, m - 1 + n, 1)).slice(0, 7);
};

export default function MonthCalendar({ month, onMonth, counts = {}, selected, onPick, countLabel = '' }) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const blanks = (first.getDay() + 6) % 7; // 周一开头
  const today = ymd(new Date());
  const canPrev = month > thisMonth();

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="lm-cal-h">
        <button type="button" disabled={!canPrev} onClick={() => onMonth(shiftMonth(month, -1))} aria-label="上个月">‹</button>
        <span>{y} 年 {m} 月</span>
        <button type="button" onClick={() => onMonth(shiftMonth(month, 1))} aria-label="下个月">›</button>
      </div>
      <div className="lm-cal">
        {'一二三四五六日'.split('').map((d) => <span key={d} className="w">{d}</span>)}
        {Array.from({ length: blanks }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, '0')}`;
          const n = counts[date] || 0;
          return (
            <button key={date} type="button" disabled={date < today} onClick={() => onPick(date)} className={n ? 'has' : undefined} aria-pressed={selected === date}>
              {i + 1}<small>{n ? `${n}${countLabel}` : ''}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
