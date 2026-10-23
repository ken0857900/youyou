import { Fragment, useEffect, useRef, useState } from 'react';
import { IMG_LINE } from '../data/mock';

// 正文＋经验保鲜度核验（流程 D，旁注式）：正文为主、核验为辅
// 电脑 ≥1024：右侧旁注栏，点句子换内容；更窄：点句子在段落下展开，再点收起。资料照后端 article_claims，不改判定、不改原文
const FRESH = { changed: '已变更', pending: '待更新', valid: '仍成立', unknown: '查无依据' };
const ORDER = ['changed', 'pending', 'valid', 'unknown'];
const KEY = { changed: '官方规定已经改了', pending: '今年的通知还没发布', valid: '官方规定仍是这样', unknown: '官方通知里没有对应规则' };
const squash = (s) => String(s ?? '').replace(/\s+/g, '');
const stOf = (c) => (FRESH[c.status] ? c.status : 'unknown');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WIDE = '(min-width: 1024px)';

// 同一句（去空白后相同）的多条核验合成一组，照文中出现顺序编号；正文里找不到的放最后（para = -1）
function freshGroups(paras, claims) {
  const sq = paras.map((p) => (IMG_LINE.test(p.trim()) ? '' : squash(p)));
  const groups = [];
  for (const c of claims) {
    const key = squash(c.sentence);
    if (!key) continue;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      const para = sq.findIndex((p) => p.includes(key));
      g = { key, sentence: c.sentence, para, pos: para < 0 ? Infinity : para * 1e6 + sq[para].indexOf(key), items: [] };
      groups.push(g);
    }
    g.items.push(c);
  }
  groups.sort((x, y) => x.pos - y.pos);
  groups.forEach((g, i) => { g.id = i; g.st = ORDER.find((st) => g.items.some((c) => stOf(c) === st)); });
  return groups;
}
// 段落切成「文字／标注」：先逐字找原句，找不到再容许空白、换行不同；都切不出（例如跟另一句重叠）的放 lost，段末补小标记
function splitPara(text, gs) {
  let parts = [text];
  const lost = [];
  for (const g of gs) {
    let hit = false;
    parts = parts.flatMap((p) => {
      if (hit || typeof p !== 'string') return [p];
      let i = p.indexOf(g.sentence), len = g.sentence.length;
      if (i < 0) {
        const m = new RegExp([...squash(g.sentence)].map(reEsc).join('\\s*')).exec(p);
        if (m) { i = m.index; len = m[0].length; }
      }
      if (i < 0) return [p];
      hit = true;
      return [p.slice(0, i), { g, text: p.slice(i, i + len) }, p.slice(i + len)];
    });
    if (!hit) lost.push(g);
  }
  return { parts, lost };
}

// 一条核验：状态、主题、原文说法、现行规定、官方原文、官方依据（没网址就不做链接；没有核验时间就不写）
function FreshItem({ c }) {
  const st = stOf(c);
  const topic = [c.program, c.rule_type].filter(Boolean).join(' · ');
  const now = st === 'unknown' ? '光华官方通知里没有对应的规则，无法核对——这不代表这句是错的，只是没有官方依据。'
    : `${c.reason || ''}${st === 'pending' ? `（${new Date().getFullYear()} 年通知尚未发布，以上依据 ${c.year} 年通知）` : ''}`;
  const meta = [c.year && `光华 ${c.year} 年通知`, c.checkedAt && `核验于 ${String(c.checkedAt).slice(0, 10)}`].filter(Boolean).join(' · ');
  return (
    <div className={`fx fx-${st}`}>
      <p className="fx-h"><span className="fx-st">{FRESH[st]}</span>{topic && <span className="fx-topic">{topic}</span>}</p>
      <dl>
        <div><dt>原文说法</dt><dd className="fx-old">「{c.sentence}」</dd></div>
        {now && <div><dt>现行规定</dt><dd>{now}</dd></div>}
        {c.quote && <div><dt>官方原文</dt><dd className="fx-q">「{c.quote.replace(/\s*\n\s*/g, '')}」</dd></div>}
        {(c.noticeUrl || c.noticeTitle || meta) && (
          <div><dt>官方依据</dt><dd className="fx-src">
            {c.noticeUrl ? <a href={c.noticeUrl} target="_blank" rel="noreferrer">{c.noticeTitle || '查看通知原文'}</a> : c.noticeTitle}
            {meta && <small>{meta}</small>}
          </dd></div>
        )}
      </dl>
    </div>
  );
}
function FreshPanel({ g, n, onClose, onStep }) {
  return (
    <>
      <div className="fr-side-h"><span>核验旁注 · {g.id + 1} / {n}</span><button type="button" className="fr-x" aria-label="收起核验旁注" onClick={onClose}>×</button></div>
      {g.items.length > 1 && <p className="fx-multi">这句话有 {g.items.length} 条核验</p>}
      {g.items.map((c, i) => <FreshItem key={i} c={c} />)}
      <div className="fr-nav">
        <button type="button" data-step="-1" disabled={g.id === 0} onClick={() => onStep(-1)}>← 上一条</button>
        <button type="button" data-step="1" disabled={g.id === n - 1} onClick={() => onStep(1)}>下一条 →</button>
      </div>
    </>
  );
}
function FreshGuide({ groups }) {
  const sts = ORDER.filter((st) => groups.some((g) => g.items.some((c) => stOf(c) === st)));
  return (
    <>
      <div className="fr-side-h"><span>核验旁注</span></div>
      <p className="fr-guide">点击文章中有标记的文字，查看对应的官方核验结果。</p>
      <ul className="fr-key">{sts.map((st) => <li key={st}><span className={`fr fr-${st}`}>{FRESH[st]}</span><span>{KEY[st]}</span></li>)}</ul>
    </>
  );
}
// 顶部摘要：数字全由资料算，0 的状态不显示；点数字依序跳到那一类的句子
function FreshSummary({ claims, onPick }) {
  const n = (st) => claims.filter((c) => stOf(c) === st).length;
  const yrs = [...new Set(claims.map((c) => c.year).filter(Boolean))].sort();
  return (
    <div className="fr-sum">
      <b>经验保鲜度核验</b>
      <span>本文已比对 {claims.length} 项光华招生规则{yrs.length > 0 && `，对照光华 ${yrs.join('、')} 年官方通知`}</span>
      <span className="fr-cnts">
        {ORDER.filter(n).map((st, i) => (
          <Fragment key={st}>
            {i > 0 && <i aria-hidden="true">·</i>}
            <button type="button" className={`fr-cnt fr-${st}`} title={`依序跳到「${FRESH[st]}」的句子`} onClick={() => onPick(st)}>{`${n(st)} 项${FRESH[st]}`}</button>
          </Fragment>
        ))}
      </span>
    </div>
  );
}

function useWide() {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

// 正文按空行分段；整段刚好是图片标记就渲染成图（点开放大）。只出 React 元素，不吃任何 HTML
export default function ArticleBody({ text, claims = [] }) {
  const [big, setBig] = useState(null);
  const [cur, setCur] = useState(null);
  const wide = useWide();
  const box = useRef(null);
  const marks = useRef({});
  const after = useRef(null);  // 换选取后要做的事（捲动、移焦点）
  const pos = useRef({});
  const paras = text.split(/\n\s*\n/);
  const groups = claims.length ? freshGroups(paras, claims) : [];
  const has = groups.length > 0;
  const behavior = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  useEffect(() => { const f = after.current; after.current = null; f?.(); }, [cur]);
  useEffect(() => {
    if (cur == null) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || !box.current?.contains(document.activeElement)) return;
      const m = marks.current[cur]; setCur(null); m?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cur]);

  const pick = (id) => setCur((c) => (!wide && c === id ? null : id));  // 电脑再点同一句维持选取；窄萤幕再点收起
  const go = (id, focusStep) => {
    after.current = () => {
      marks.current[id]?.scrollIntoView({ block: wide ? 'center' : 'start', behavior: behavior() });
      const f = focusStep && box.current.querySelector(`${wide ? '.fr-side' : '.fr-inline'} [data-step="${focusStep}"]:not(:disabled)`);
      (f || marks.current[id])?.focus({ preventScroll: true });
    };
    setCur(id);
  };
  const close = () => { const m = marks.current[cur]; setCur(null); m?.focus({ preventScroll: true }); };
  const step = (d) => go(cur + d, String(d));
  const pickStatus = (st) => {
    const ids = groups.filter((g) => g.items.some((c) => stOf(c) === st)).map((g) => g.id);
    pos.current[st] = ((pos.current[st] ?? -1) + 1) % ids.length;
    go(ids[pos.current[st]]);
  };
  const panel = (g) => <FreshPanel g={g} n={groups.length} onClose={close} onStep={step} />;
  // 标注是普通函式不是元件：重绘时 <mark> 不会被换掉，焦点才留得住
  const mark = (g, children, tail = false, key = g.id) => (
    <mark key={key} ref={(el) => { marks.current[g.id] = el; }} className={`fr fr-${g.st}${tail ? ' fr-tail' : ''}`} role="button" tabIndex={0}
      aria-pressed={cur === g.id} title="点击查看最新规定" onClick={() => pick(g.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(g.id); } }}>
      {children}<span className="vh">（{g.items.map((c) => FRESH[stOf(c)]).join('、')}，点击查看最新规定）</span>
    </mark>
  );
  const withFresh = (gs, content) => {
    const g = !wide && cur != null && gs.find((x) => x.id === cur);
    return (
      <div className="para">
        {content}
        {g && <div className={`fr-inline fx-${g.st}`} role="region" aria-label="核验依据">{panel(g)}</div>}
      </div>
    );
  };

  const body = paras.map((p, i) => {
    const m = p.trim().match(IMG_LINE);
    if (m) return <img key={i} src={m[1]} alt="文章配图" loading="lazy" onClick={() => setBig(m[1])} />;
    const gs = groups.filter((g) => g.para === i);
    if (!gs.length) return <p key={i}>{p}</p>;
    const { parts, lost } = splitPara(p, gs);
    return (
      <Fragment key={i}>
        {withFresh(gs, (
          <p>
            {parts.map((x, j) => (typeof x === 'string' ? x : mark(x.g, x.text, false, j)))}
            {lost.map((g) => <Fragment key={g.id}> {mark(g, '〔核验〕', true)}</Fragment>)}
          </p>
        ))}
      </Fragment>
    );
  });
  const orphans = groups.filter((g) => g.para < 0);

  return (
    <div ref={box} className={`ar-body${has ? ' fr-on' : ''}`}>
      {has ? (
        <>
          <div className="fr-text">
            <FreshSummary claims={claims} onPick={pickStatus} />
            {body}
            {orphans.length > 0 && withFresh(orphans, (
              <p className="fr-more">另有 {orphans.length} 条核验对应的句子未能在正文中定位：{orphans.map((g) => <Fragment key={g.id}> {mark(g, `〔${g.id + 1}〕`, true)}</Fragment>)}</p>
            ))}
          </div>
          <aside className="fr-side" aria-label="核验旁注" aria-live="polite">
            {wide && cur != null ? panel(groups[cur]) : <FreshGuide groups={groups} />}
          </aside>
        </>
      ) : body}
      {big && (
        <div onClick={() => setBig(null)} className="zoom" role="dialog" aria-label="查看大图">
          <img src={big} alt="文章配图大图" />
        </div>
      )}
    </div>
  );
}
