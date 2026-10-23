import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CATEGORIES } from '../data/mock';

// 搜索弹窗「寻找相似经历」：页头放大镜、首页 hero、选单都开这一个
// 只有按「找相似经历」才送出 → /search?q=关键词&type=保研&type=考研（q 可以空；type 是决策类型，可多选，不勾就不限）
const TYPES = CATEGORIES.map((c) => c.name);  // 经历类型＝决策类型，跟主题分类同一组
const HOT = ['光华金融硕士', '光华夏令营', '没拿到优营', '九推', '直博还是读硕', '跨专业申光华'];
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const Ctx = createContext(() => {});
// oxlint-disable-next-line react/only-export-components -- hook 跟 Provider 放一起
export const useSearchModal = () => useContext(Ctx);

export function SearchModalProvider({ children }) {
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);
  const [on, setOn] = useState(false);
  const [q, setQ] = useState('');
  const [types, setTypes] = useState([]);
  const box = useRef(null);
  const ta = useRef(null);
  const st = useRef({ from: null, y: 0, timer: 0 });

  // 关的动画还没跑完时再开：取消「关完」那一步，直接重新打开（不会被吃掉）
  const open = useCallback(({ q: q0 = '', types: t0 = [], from = document.activeElement } = {}) => {
    clearTimeout(st.current.timer);
    st.current.from = from;
    if (!document.documentElement.classList.contains('lm-lock')) st.current.y = window.scrollY;
    setQ(q0); setTypes(t0); setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
  }, []);
  const finish = (restore) => {
    setMounted(false);
    document.documentElement.classList.remove('lm-lock');
    if (restore) { window.scrollTo(0, st.current.y); st.current.from?.focus?.({ preventScroll: true }); }
  };
  const close = useCallback(() => {
    setOn(false);
    clearTimeout(st.current.timer);
    if (reduced()) finish(true); else st.current.timer = setTimeout(() => finish(true), 320);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.classList.add('lm-lock');
    const t = ta.current;
    t.focus({ preventScroll: true });
    t.setSelectionRange(t.value.length, t.value.length);
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {  // 焦点只在弹窗里循环
        const f = [...box.current.querySelectorAll('button, textarea, input')].filter((el) => el.offsetParent !== null);
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mounted, close]);

  const submit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams();
    p.set('q', q.replace(/\s+/g, ' ').trim());
    types.forEach((t) => p.append('type', t));
    clearTimeout(st.current.timer);
    setOn(false); finish(false);
    navigate(`/search?${p}`);
  };
  const toggle = (t) => setTypes((xs) => (xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t]));

  return (
    <Ctx.Provider value={open}>
      {children}
      {mounted && (
        <div className={`lm-smd${on ? ' on' : ''}`}>
          <div className="lm-smd-scrim" onClick={close} />
          <form ref={box} className="lm-smd-box" role="dialog" aria-modal="true" aria-labelledby="lm-smd-h" noValidate onSubmit={submit}>
            <button className="lm-x" type="button" aria-label="关闭搜索" onClick={close}><i /><i /></button>
            <div className="lm-smd-hd"><span className="lm-smd-en">SEARCH</span><h2 id="lm-smd-h">寻找相似经历</h2></div>
            <div className="lm-smd-sec">
              <label className="lm-smd-lab" htmlFor="lm-smd-q">关键词／处境描述</label>
              <textarea ref={ta} id="lm-smd-q" rows={3} value={q} onChange={(e) => setQ(e.target.value)} placeholder="例如：双非金融大三，想申光华金融硕士，夏令营怎么准备？" />
              <div className="lm-smd-hot">
                <span>热门搜索：</span>
                <div className="lm-smd-hot-w"><div className="lm-smd-hot-l">
                  {HOT.map((h) => <button key={h} type="button" onClick={() => { setQ(h); ta.current.focus(); }}>{h}</button>)}
                </div></div>
              </div>
            </div>
            <div className="lm-smd-sec" role="group" aria-labelledby="lm-smd-t">
              <span className="lm-smd-lab" id="lm-smd-t">筛选经历类型<small>可多选，不勾就不限</small></span>
              <div className="lm-smd-types">
                {TYPES.map((t) => (
                  <label key={t}><input type="checkbox" name="type" value={t} checked={types.includes(t)} onChange={() => toggle(t)} />{t}</label>
                ))}
              </div>
            </div>
            <div className="lm-smd-ft"><button className="lm-smd-go" type="submit">找相似经历<span aria-hidden="true">→</span></button></div>
          </form>
        </div>
      )}
    </Ctx.Provider>
  );
}
