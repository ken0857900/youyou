// 列表页抬头（新设计）：衬纸色带＋小标（label 里用 <em> 标金色的字）＋宋体大标题＋说明
export default function PageHead({ label, title, sub, children }) {
  return (
    <section className="lm-pg-h lm-bleed"><div className="lm-wrap">
      <span className="lm-pg-lab">{label}</span>
      <h1>{title}</h1>
      {sub && <p className="sub">{sub}</p>}
      {children}
    </div></section>
  );
}
