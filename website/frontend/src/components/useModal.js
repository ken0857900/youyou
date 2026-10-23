import { useEffect, useRef } from 'react';

// 弹窗共用：开着时锁背景捲动、焦点移进弹窗；Esc 关；关掉后焦点回到原本的元素
export default function useModal(onClose) {
  const box = useRef(null);
  useEffect(() => {
    const from = document.activeElement;
    const root = document.documentElement;
    const locked = root.classList.contains('lm-lock');
    root.classList.add('lm-lock');
    box.current?.querySelector('button, a, input, textarea, select')?.focus({ preventScroll: true });
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (!locked) root.classList.remove('lm-lock'); from?.focus?.({ preventScroll: true }); };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return box;
}
