import { useEffect, useRef, useState } from 'react';
import { ARTICLES } from '../data/mock';
import { useSearchModal } from './SearchModal';
import useModal from './useModal';
import '../pages/story.css';

// 「前路」（原本在品牌故事页底部）：全站右边一个收起来的小签，点开是全屏面板，里面照旧往下滚动走山路。
// 用一个例子说明搜索页真正跑的六步（示意，不是即时数据）；动画在 pages/storyScene.js
// 照 docs/03 流程 B ①～⑦：⑥ 引用核验与 ⑦ 审查并成最后一格
const STEPS = [['处境抽取', '双非 · 金融 · 保研 · 没拿到优营'], ['两路召回', '按条件过滤后，向量＋全文两路召回'], ['重排', 'bge-reranker 按跟你的话有多接近排序'], ['分群', '跟你最像／起点比你好／跨专业来的'], ['判断', '每群一个 agent，写「为什么是他」'], ['核验与审查', '逐字核对引用原话，站不住就打回']];
const CN = '一二三四五六';
const EXAMPLE = '双非金融申光华没拿到优营怎么办';
// 山路：从左下山脚弯进群山，终点是红日（.lp-sun）
const TRAIL = 'M 360 550 C 470 490, 420 430, 520 400 S 720 370, 650 300 S 560 235, 680 205 S 830 205, 795 155';

function Path({ scroller, onTry }) {
  const root = useRef(null);
  const open = useSearchModal();
  useEffect(() => {
    let cleanup = null, dead = false;
    import('../pages/storyScene.js').then((m) => { if (!dead && root.current) cleanup = m.mount(root.current, scroller); });
    return () => { dead = true; cleanup?.(); };
  }, [scroller]);
  // 收录数字：照资料现算
  const arts = ARTICLES.filter((a) => a.type === 'article');
  const dp = arts.reduce((n, a) => n + (a.decisionPoints?.length || (a.decisionPoint ? 1 : 0)), 0);
  const majors = new Set(arts.map((a) => a.decisionPoint?.专业).filter((m) => m && m !== '未提及')).size;
  const num = (n) => <b data-n={n}>{n}</b>;

  return (
    <section className="lm-path" ref={root} aria-labelledby="lp-h">
      <div className="lp-stage">
        <canvas aria-hidden="true" />
        <svg className="lp-svg" viewBox="335 95 515 470" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <circle className="lp-sun" cx="800" cy="142" r="40" />{/* 红日在山路尽头（背景着色器的太阳关掉了） */}
          <path className="lp-trail" d={TRAIL} />
          <path className="lp-ink" d={TRAIL} />
          {STEPS.map(([k], i) => <g key={k} className="lp-node"><circle r="15" /><text dy="5">{CN[i]}</text></g>)}
          <circle className="lp-me" r="6" />
        </svg>
        <div className="lp-cap">
          <span className="lp-label">前路</span>
          <h2 id="lp-h">每一条前路，<br />都有人走过。</h2>
          <p>已收录 {num(arts.length)} 篇经验 · {num(dp)} 个决策点 · {num(majors)} 个专业</p>
        </div>
        <div className="lp-card">
          <p className="lp-kicker"><em>鹿鸣</em>怎么帮你找人</p>
          <p className="lp-q">比如你问<b>「{EXAMPLE}」</b>，鹿鸣会这样找：</p>
          <ol className="lp-steps">{STEPS.map(([k, d], i) => <li key={k}><span className="k">{CN[i]}</span><b>{k}</b><small>{d}</small></li>)}</ol>
          <div className="lp-res"><span className="res-k">再按处境分群</span><span className="chip">一战没过，二战上岸</span><span className="chip">失败之后转了方向</span>
            <button type="button" className="go" onClick={() => { onTry(); open({ q: EXAMPLE, from: document.querySelector('.lp-tab') }); }}>用你的处境试试 →</button></div>
        </div>
        <span className="lp-hint" />
      </div>
    </section>
  );
}

// 面板：电脑上是置中的小视窗、手机全屏，自己捲动（山路的进度跟着面板捲，不跟整页）；Esc、✕、点遮罩、点「试试」都会关
function Panel({ onClose }) {
  const box = useModal(onClose);
  const [scroller, setScroller] = useState(null);
  return (
    <>
      <div className="lp-dock-bg" aria-hidden="true" onClick={onClose} />
      <div className="lp-dock" role="dialog" aria-modal="true" aria-label="前路：鹿鸣怎么帮你找人" ref={box}>
        <button type="button" className="lp-dock-x" aria-label="关闭前路" onClick={onClose}>✕</button>
        <div className="lp-dock-scroll" ref={setScroller}>
          {scroller && <Path scroller={scroller} onTry={onClose} />}
        </div>
      </div>
    </>
  );
}

export default function PathDock() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="lp-tab" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <i aria-hidden="true" /><span>前路</span>
      </button>
      {open && <Panel onClose={() => setOpen(false)} />}
    </>
  );
}
