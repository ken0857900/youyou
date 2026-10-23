import { useEffect, useState } from 'react';

// 回到顶部：往下捲超过一个画面才出现；按下平滑捲回顶部（减少动态效果就直接跳），焦点回到页头品牌
export default function BackToTop() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const update = () => setOn(window.scrollY > window.innerHeight * 0.8);
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, []);
  const top = () => {
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    document.querySelector('.lm-brand')?.focus({ preventScroll: true });
  };
  return (
    <button type="button" className={`lm-totop${on ? ' on' : ''}`} aria-label="回到顶部" tabIndex={on ? 0 : -1} onClick={top}>
      <i aria-hidden="true" /><span>Top</span>
    </button>
  );
}
