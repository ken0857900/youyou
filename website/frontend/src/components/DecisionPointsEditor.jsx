import { CATEGORIES, OUTCOMES, SCHOOL_TIERS } from '../data/mock';

// 写作页：大模型抽出来的决策点给作者看、改；一篇可以有多个（例：保研失败 → 考研上岸）
const NA = '未提及';
const SELECTS = {
  决策类型: CATEGORIES.map((c) => c.name),
  学校层级: SCHOOL_TIERS,
  结果: OUTCOMES,
};
const TEXTS = [['专业', '例：金融学'], ['成绩', '例：GPA 3.4'], ['年级', '例：大三'], ['最后的选择', '例：保研'], ['结果说明', '例：拿到光华优营'], ['年份', '例：2024']];
const field = 'lm-in';

export const blankPoint = () => ({ 决策类型: NA, 学校层级: NA, 专业: NA, 成绩: NA, 年级: NA, 考虑过的选项: [], 最后的选择: NA, 结果: NA, 结果说明: NA, 年份: NA, 原话: NA });

export default function DecisionPointsEditor({ points, onChange }) {
  const set = (i, k, v) => onChange(points.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const label = (k) => <span>{k}</span>;

  return (
    <div>
      {points.map((p, i) => (
        <div key={i} className="lm-dpe">
          <div className="lm-dpe-h">
            <h3>决策点 {i + 1}</h3>
            {points.length > 1 && <button type="button" onClick={() => onChange(points.filter((_, j) => j !== i))}>删除这个</button>}
          </div>
          <div className="lm-dpe-g">
            {Object.entries(SELECTS).map(([k, opts]) => (
              <label key={k} className="lm-fl">{label(k)}
                <select value={p[k]} onChange={(e) => set(i, k, e.target.value)} className={field}>
                  {[NA, ...opts].map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>
            ))}
            {TEXTS.map(([k, ph]) => (
              <label key={k} className="lm-fl">{label(k)}
                <input value={p[k] === NA ? '' : p[k]} placeholder={ph} onChange={(e) => set(i, k, e.target.value.trim() ? e.target.value : NA)} className={field} />
              </label>
            ))}
          </div>
          <label className="lm-fl">{label('考虑过的选项（用顿号分开）')}
            <input value={(p.考虑过的选项 || []).join('、')} placeholder="例：保研、考研、工作"
              onChange={(e) => set(i, '考虑过的选项', e.target.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean))} className={field} />
          </label>
          <label className="lm-fl">{label('原话（必须是正文里的原句，读者会看到）')}
            <textarea rows={2} value={p.原话 === NA ? '' : p.原话} onChange={(e) => set(i, '原话', e.target.value.trim() ? e.target.value : NA)} className={field} />
          </label>
        </div>
      ))}
      <button type="button" className="add" onClick={() => onChange([...points, blankPoint()])}>＋ 再加一个决策点</button>
    </div>
  );
}
