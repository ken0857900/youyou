import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getArticle, getPerson, isMentioned } from '../data/mock';
import { agentSearch, pickWhy, source } from '../data/api';
import {
  FILTER_FIELDS, PATH_FIELD, betterGroup, countBy, groupResults, groupStats, optionsFor, parseQuery, processLog, search,
} from '../data/mockSearch';
import BookingModal from '../components/BookingModal';
import SearchNotFound from '../components/SearchNotFound';
import { MatchLegend, MatchLight, matchRank } from '../components/WhyBlock';
import './search.css';

const statLine = (counts) => Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' / ');

// 路由页：q 或勾的经历类型变了就整个重建（筛选条件回到 AI 自动勾的状态）
// type＝搜索弹窗勾的经历类型（只收资料里真的有的「决策类型」值），可多个：/search?q=…&type=保研&type=考研
export default function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const types = params.getAll('type').filter((v) => optionsFor('决策类型').includes(v));
  return <SearchView key={`${q}|${types.join(',')}`} q={q} types={types} fallback={params.get('fallback') === '1'} />;
}

// 勾的经历类型并进 AI 抽到的条件；有勾（或根本没打字）就不算「无关问题」
function withTypes(p, q, types) {
  const filters = { ...p.filters, 决策类型: [...new Set([...p.filters.决策类型, ...types])] };
  return { ...p, filters, irrelevant: p.irrelevant && !!q.trim() && !types.length };
}

function SearchView({ q, types, fallback }) {
  const navigate = useNavigate();
  const [parsed, setParsed] = useState(() => withTypes(parseQuery(q), q, types)); // 先用关键词版即时出画面，后端 LLM 抽完（result 事件）再换掉
  const [filters, setFilters] = useState(parsed.filters);
  const touched = useRef(false); // 读者动过筛选就不再被后端覆盖
  const [showFilters, setShowFilters] = useState(false);
  const [tab, setTab] = useState('all');
  const [input, setInput] = useState(q);
  const [booking, setBooking] = useState(null);
  const [done, setDone] = useState(undefined); // undefined = 后端还在跑；null = 没后端/出错；否则 { steps, llmCalls, cachedAt }
  const [live, setLive] = useState([]); // SSE 推来的步骤
  const [agentGroups, setAgentGroups] = useState({}); // 群 id → agent 版（判断完一群推一群）
  const [reviewed, setReviewed] = useState({}); // 群 id → 审查通过
  const [ready, setReady] = useState(source !== 'db'); // 有后端时等它的 result（LLM 抽的处境）再出结果，免得关键词版先闪一次
  const held = useRef({}); // 判断完、还没审完的群先放这里，审完才一次换上（同一群最多变一次）
  const [lights, setLights] = useState(null); // 文章 id → { match 红绿灯, hit 对上几条 }（跟主题／人物页同一个接口 07 #11，另一个请求、晚几秒到）

  useEffect(() => {
    if (!q.trim() || source !== 'db') return undefined;
    let dead = false;
    pickWhy(q).then((w) => { if (!dead) setLights(w); }).catch(() => {});
    return () => { dead = true; };
  }, [q]);
  const lit = lights && Object.keys(lights).length > 0;
  // 灯回来了、却没有一篇红或黄：没有符合的，标题改成「猜你想看」（例：搜「台湾」，库里没人写过）
  const noFit = lit && !Object.values(lights).some((w) => w.match === 'high' || w.match === 'mid');
  const light = (id) => lights?.[id]?.match;

  useEffect(() => {
    // 关键词版本地即时算好（跟后端 result 同一套规则），SSE 只叠 agent 的部分
    if (!q.trim()) { setReady(true); setDone(null); return undefined; }  // 只勾类型、没打字：不叫后端，直接按类型筛
    const ctl = new AbortController();
    agentSearch(q, {
      result: (r) => {
        setReady(true);
        if (touched.current) return;
        const p = withTypes({ ...r, textHits: new Set(r.textHits) }, q, types);
        setParsed(p); setFilters(p.filters);
      },
      step: (s) => setLive((l) => [...l, s]),
      group: (g) => {
        if (g.members.length) held.current[g.id] = g; // 审查可能打回重判，先不显示
        else setAgentGroups((m) => ({ ...m, [g.id]: g })); // 整群不像：已是定论
      },
      review: (r) => {
        const g = held.current[r.id];
        if (g) setAgentGroups((m) => ({ ...m, [r.id]: g }));
        setReviewed((m) => ({ ...m, [r.id]: r.pass }));
      },
    }, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return;
      setReady(true); setDone(r);
      setAgentGroups((m) => ({ ...held.current, ...m })); // 超时没审完的：有判断结果就用
    });
    return () => ctl.abort();
  }, [q]);  // eslint-disable-line react-hooks/exhaustive-deps -- types 变了整个 SearchView 会重建

  const submit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams({ q: input.trim() });
    types.forEach((t) => p.append('type', t));  // 重新搜索时保留勾的经历类型
    if (fallback) p.set('fallback', '1');
    navigate(`/search?${p}`);
  };
  const pick = (f) => { touched.current = true; setFilters(f); };
  const toggle = (field, value) =>
    pick((f) => ({ ...f, [field]: f[field].includes(value) ? f[field].filter((v) => v !== value) : [...f[field], value] }));

  // 有后端：结果池＝RAG 召回＋rerank 的文章（按匹配先后），筛选在池里再筛；没后端才对全部文章跑关键词版
  // ponytail: 召回时已套 AI 抽的条件，读者取消某个条件不会把池子放大；要放大得用新条件重打一次后端
  const ids = parsed.results;
  const results = search(parsed, filters, undefined, ids);
  // 读者还没改筛选 → 判断完的群换成 agent 版（代表排前、理由、引用）；没判断完的维持关键词版
  const useAgent = filters === parsed.filters && Object.keys(agentGroups).length > 0;
  const toArticles = (ids) => ids.map(getArticle).filter(Boolean);
  const overlay = (g) => {
    if (!g) return g; // 没有「起点比你好」群时 betterGroup 回 null
    const a = useAgent && agentGroups[g.id];
    return a ? { ...g, members: toArticles(a.members), why: a.why, reviewed: reviewed[g.id] } : { ...g, judging: done === undefined && filters === parsed.filters };
  };
  const isFallback = fallback;
  const guesses = noFit ? results.filter((a) => lights[a.id]?.hit > 0) : []; // 至少对上一条才算「差不多」
  const fallbackList = results.slice(0, 5);
  const rawGroups = groupResults(results, parsed.situation);
  const grouped = rawGroups.map(overlay).filter((g) => g.members.length); // agent 判断整群不像 → members 空，拿掉
  const groups = useAgent || grouped.some((g) => g.members.length > 1) ? grouped : []; // 每群都只有 1 人就不分群
  // 不受学校层级筛选影响的「起点比你好」
  const extraGroup = isFallback ? null : overlay(betterGroup(parsed, filters, rawGroups));
  const extra = extraGroup?.members.length ? extraGroup : null;
  // 只有一群且等于全部时，这个标签是多余的（区块标题照样在「全部」里显示）
  const mainTabs = groups.length === 1 && groups[0].members.length === results.length ? [] : groups;
  const tabGroups = extra ? [...mainTabs, extra] : mainTabs;
  // 「看这群全部」：只有一个主群时它没有标签，所以从全部群里找（原本按了没反应）
  const active = [...groups, ...(extra ? [extra] : [])].find((g) => g.id === tab);
  // 每个选项的数量：用「除了这个字段以外」的条件算（电商式）
  const pool = (skip) => search(parsed, filters, skip, ids);

  const nSel = Object.values(filters).flat().length;
  const head = (n) => (
    <section className="sr-head lm-bleed"><div className="lm-wrap">
      <span className="label">搜索<em>结果</em></span>
      <h1 className="sr-h">
        {q ? `「${q}」` : types.length ? `「${types.join(' · ')}」` : '全部经验'}
        {n > 0 && !noFit && <small>{q || types.length ? '找到 ' : '共 '}<b>{n}</b>{q || types.length ? ' 位走过的人' : ' 位分享者的决策'}</small>}
      </h1>
      <form className="sbox" onSubmit={submit}>
        <div className="s-row">
          <svg className="s-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" strokeLinecap="round" /></svg>
          <input value={input} onChange={(e) => setInput(e.target.value)} aria-label="说说你现在的处境" autoComplete="off" placeholder="例：双非金融 排名前 10% 大三，光华夏令营报高金还是科创" />
          <button className="s-go">找相似经历<span aria-hidden="true">→</span></button>
        </div>
      </form>
      {!parsed.irrelevant && ready && (
        <div>
          {parsed.query && <p className="sr-ai">已按「<b>{parsed.query}</b>」搜索<small>（AI 修正了可能的错字）</small></p>}
          {types.length > 0 && <p className="sr-ai">你勾选了：<b>{types.join(' · ')}</b><small>（可在筛选条件里修改）</small></p>}
          {parsed.labels.length > 0 && <p className="sr-ai">AI 理解为：<b>{parsed.labels.join(' · ')}</b><small>（已自动勾选，可在筛选条件里修改）</small></p>}
          {lit && <MatchLegend />}
        </div>
      )}
    </div></section>
  );
  const pills = (field) => Object.entries(countBy(pool(field), field)).map(([v, n]) => (
    <button key={v} type="button" className="pill" aria-pressed={filters[field].includes(v)} onClick={() => toggle(field, v)}>{v}<small>{n}</small></button>
  ));

  if (!ready) {
    return (
      <div className="lm-sr">
        {head(0)}
        <div className="lm-wrap sr-body" style={{ gridTemplateColumns: '1fr' }}>
          <p className="sr-ai">AI 正在理解你的处境…</p>
          {live.length > 0 && <div className="proc"><ol>{live.map((st, i) => <li key={i}>{stepText(st)}</li>)}</ol></div>}
        </div>
      </div>
    );
  }

  if (parsed.irrelevant) {
    return (
      <div className="lm-sr">
        {head(0)}
        <div className="lm-wrap sr-body" style={{ gridTemplateColumns: '1fr' }}><SearchNotFound q={q} irrelevant /></div>
      </div>
    );
  }

  return (
    <div className="lm-sr">
      {head(results.length)}
      <div className="lm-wrap sr-body">
        <aside className="flt">
          <button type="button" className="flt-t" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
            <b>筛选条件</b>{nSel > 0 && <small>已选 {nSel}</small>}<i aria-hidden="true" />
          </button>
          {showFilters && FILTER_FIELDS.map((field) => {
            const counts = countBy(pool(field), field);
            return (
              <div key={field} className="flt-f">
                <h3>{field}</h3>
                {optionsFor(field).map((v) => (
                  <label key={v} className={counts[v] ? undefined : 'zero'}>
                    <input type="checkbox" checked={filters[field].includes(v)} onChange={() => toggle(field, v)} />
                    <span>{v}</span><small>{counts[v] || 0}</small>
                  </label>
                ))}
              </div>
            );
          })}
        </aside>

        <section style={{ minWidth: 0 }}>
          {results.length === 0 ? (
            <SearchNotFound q={q} parsed={parsed} filters={filters} onApply={pick} />
          ) : noFit ? (
            <>{/* 灯全绿：先给没有答案的画面，下面再列字卡当「猜你想看」 */}
              <SearchNotFound q={q} parsed={parsed} filters={filters} onApply={pick} guess />
              {guesses.length > 0 && (
                <section className="grp">
                  <header className="grp-h"><div className="grp-t"><span className="fish">◆</span><h2>猜你想看</h2><span className="grp-n">{guesses.length} 篇</span></div></header>
                  <div className="cards">{guesses.map((a) => <ResultCard key={a.id} article={a} onBook={setBooking} why={lights?.[a.id]} light={light(a.id)} />)}</div>
                </section>
              )}
            </>
          ) : (
            <>
              {!isFallback && tabGroups.length > 0 && (
                <div className="ktab" role="tablist" aria-label="分群">
                  <button type="button" role="tab" aria-selected={!active} onClick={() => setTab('all')}>全部<small>{results.length}</small></button>
                  {tabGroups.map((g) => (
                    <button key={g.id} type="button" role="tab" aria-selected={active === g} onClick={() => setTab(g.id)}>{g.name}<small>{g.members.length}</small></button>
                  ))}
                </div>
              )}
              <div className="stats">
                <div><span>走了哪些路</span>{pills(PATH_FIELD)}</div>
                <div><span>结果</span>{pills('结果')}</div>
              </div>
              {isFallback ? (
                <div className="grp">
                  <p className="fb-note">分群判断超时，先显示最相关的 5 位</p>
                  <div className="list">{fallbackList.map((a) => <ResultCard key={a.id} article={a} onBook={setBooking} why={lights?.[a.id]} light={light(a.id)} />)}</div>
                </div>
              ) : active ? (
                <GroupBlock group={active} all onBook={setBooking} lights={lights} />
              ) : (
                <>
                  {groups.length
                    ? groups.map((g) => <GroupBlock key={g.id} group={g} onBook={setBooking} onMore={() => setTab(g.id)} lights={lights} />)
                    : <div className="grp"><div className="list">{byLight(results, lights).map((a) => <ResultCard key={a.id} article={a} onBook={setBooking} why={lights?.[a.id]} light={light(a.id)} />)}</div></div>}
                  {extra && <GroupBlock group={extra} onBook={setBooking} onMore={() => setTab(extra.id)} lights={lights} />}
                </>
              )}
            </>
          )}

          <ProcessPanel
            pending={done === undefined}
            cachedAt={done?.cachedAt}
            steps={live.length && filters === parsed.filters ? (done?.steps || live).map(stepText) : processLog(filters, results, isFallback ? [] : grouped, isFallback, extra, live.length > 0)}
          />
        </section>
      </div>

      {booking && <BookingModal person={booking} onClose={() => setBooking(null)} />}
    </div>
  );
}

// 灯到了：红 → 黄 → 绿 → 没灯，同色维持原顺序（agent 代表排前），跟主题／人物页一样
const byLight = (list, lights) => (lights ? [...list].sort((a, b) => matchRank(lights[a.id]) - matchRank(lights[b.id])) : list);

function GroupBlock({ group, all, onBook, onMore, lights }) {
  const { paths, outcomes } = groupStats(group.members);
  const sorted = byLight(group.members, lights);
  const shown = all ? sorted : sorted.slice(0, 2);
  return (
    <section className="grp">
      <header className="grp-h">
        <div className="grp-t">
          <span className="fish">◆</span><h2>{group.label || group.name}</h2><span className="grp-n">{group.members.length} 人</span>
          {group.reviewed && <span className="badge">✓ 已审查</span>}
          {group.judging && <span className="badge judging">AI 判断中…</span>}
        </div>
        <dl className="grp-s"><div><dt>走了哪些路</dt><dd>{statLine(paths)}</dd></div><div><dt>结果</dt><dd>{statLine(outcomes)}</dd></div></dl>
      </header>
      <div className="cards">{shown.map((a) => <ResultCard key={a.id} article={a} onBook={onBook} why={group.why?.[a.id] || lights?.[a.id]} light={lights?.[a.id]?.match} />)}</div>
      {!all && group.members.length > 2 && (
        <div className="more-g"><button type="button" onClick={() => { onMore(); document.querySelector('.lm-sr .sr-body')?.scrollIntoView(); }}>看这群全部 {group.members.length} 人 →</button></div>
      )}
    </section>
  );
}

const stepText = (s) => `${s.step} ${s.label}：${s.detail}（${s.ms} ms）`;

// why = 群代表的 agent 判断，或推荐理由接口（红绿灯同一包）的 { why, unique, quotes }；都没有就不写「为什么是他」
// light = 红绿灯（high／mid／low）
function ResultCard({ article, onBook, why, light }) {
  const person = getPerson(article.authorId);
  const dp = article.decisionPoint;
  const quote = why?.quotes?.[0] || (isMentioned(dp.原话) ? dp.原话 : '');
  const bg = [dp.学校层级, dp.专业, dp.成绩, dp.年级].filter(isMentioned).join(' · ');
  return (
    <article className="rc">
      <div className="rc-top">
        <img src={person.avatar} alt="" />
        <div>
          <div className="rc-n"><Link to={`/people/${person.id}`}>{person.name}</Link><small>{dp.年份}</small><MatchLight level={light} /></div>
          <p className="rc-bg">{bg}</p>
          <p className="rc-d">{dp.决策类型} → {dp.最后的选择}<span className={`oc oc-${dp.结果}`}>{dp.结果}</span></p>
        </div>
      </div>
      {why?.why && (
        <div className="rc-pair">{/* 为什么是他｜独有的点 并排，窄才上下 */}
          <p className="rc-why"><b>为什么是他</b>{why.why}</p>
          {why.unique && why.unique !== '无' && <p className="rc-why diff"><b>独有的点</b>{why.unique}</p>}
        </div>
      )}
      {quote && <blockquote className="rc-q">「{quote}」</blockquote>}
      <div className="rc-act">
        <Link className="go" to={`/articles/${article.id}`}>看完整文章<span aria-hidden="true">→</span></Link>
        <Link className="pp" to={`/people/${person.id}`}>人物页</Link>
        {person.consultationAvailable && <button type="button" className="book" onClick={() => onBook(person)}>预约</button>}
      </div>
    </article>
  );
}

function ProcessPanel({ steps, pending, cachedAt }) {
  const hhmm = cachedAt && new Date(cachedAt * 1000).toTimeString().slice(0, 5);
  const [open, setOpen] = useState(false);
  return (
    <div className="proc">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <i aria-hidden="true" />检索过程
        <small>{pending ? '（AI 判断中…展开看进度）' : hhmm ? `（命中缓存（首次由 agent 生成于 ${hhmm}））` : '（展开看 agent 每一步）'}</small>
      </button>
      {open && <ol>{steps.map((st, i) => <li key={i}>{st}</li>)}</ol>}
    </div>
  );
}
