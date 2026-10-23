import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAppState } from '../context/AppState';
import { CATEGORIES, SITE_IMAGES, getPerson } from '../data/mock';
import Brand from './Brand';
import { useSearchModal } from './SearchModal';

// 页头（新设计）：左三条线开选单｜中间品牌｜右边搜索、通知（登录后）、写文章、登录／头像
const ROLE_LABEL = { reader: '读者', sharer: '分享者', company: '公司' };
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
// 一般左键才由我们关选单；Cmd／Ctrl／Shift／中键是开新分页，交给浏览器
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function SearchIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" strokeLinecap="round" /></svg>;
}
function BellIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" strokeLinejoin="round" /><path d="M10 20.5a2 2 0 0 0 4 0" strokeLinecap="round" /></svg>;
}

// 登录后的头像下拉：照 Ken 原本的使用者选单
function UserMenu({ user, me, onGo, onLogout }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const out = (e) => { if (!box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); box.current.querySelector('button').focus(); } };
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); };
  }, [open]);
  const go = (to) => { setOpen(false); onGo(to); };
  return (
    <div className="lm-user" ref={box}>
      <button type="button" className="lm-av" aria-expanded={open} aria-haspopup="menu" title={`${user.name}（${ROLE_LABEL[user.role]}）`} onClick={() => setOpen((v) => !v)}>
        {me?.avatar ? <img src={me.avatar} alt="我" /> : '我'}
      </button>
      {open && (
        <div className="lm-umenu" role="menu">
          <div><b>{user.name}</b><small>当前身份：{ROLE_LABEL[user.role]}</small></div>
          <button type="button" role="menuitem" onClick={() => go('/me')}>我的内容管理</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onLogout(); }}>切换身份 / 退出</button>
        </div>
      )}
    </div>
  );
}

// 展开式选单：开时锁背景、焦点进选单；Esc／遮罩／X 关，焦点回三条线；换页自动关
function Menu({ open, onClose, burger, writeTo, user, onSearch }) {
  const [mounted, setMounted] = useState(false);
  const [on, setOn] = useState(false);
  const panel = useRef(null);
  const timer = useRef(0);
  const y = useRef(0);

  useEffect(() => {
    clearTimeout(timer.current);
    const root = document.documentElement;
    if (open) {
      y.current = window.scrollY;
      root.style.setProperty('--mt', `${Math.max(0, document.querySelector('.lm-top').getBoundingClientRect().bottom)}px`);
      root.classList.add('lm-lock');
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    } else if (mounted) {
      setOn(false);
      const done = () => { setMounted(false); root.classList.remove('lm-lock'); };
      if (reduced()) done(); else timer.current = setTimeout(done, 380);
    }
  }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mounted || !open) return undefined;
    const focusables = () => [burger.current, ...panel.current.querySelectorAll('a, button')].filter((el) => el.offsetParent !== null && !(el === burger.current && isMobile()));
    (isMobile() ? panel.current.querySelector('.lm-m-close') : focusables()[1])?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(true); return; }
      if (e.key === 'Tab') {  // 焦点只在三条线和选单之间循环
        const f = focusables(), i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mounted, open, burger, onClose]);

  if (!mounted) return null;
  const L = (to, label, hint) => (
    <Link className="lm-m-a" to={to} onClick={(e) => { if (plainClick(e)) onClose(false); }}>{label}{hint && <small>{hint}</small>}</Link>
  );
  const COLS = [
    ['找经验', 'EXPLORE', [
      <li key="t">{L('/topics', '主题分类')}</li>,
      <li key="c" className="lm-m-cats">{CATEGORIES.map((c) => <Link key={c.id} className="lm-m-a" to={`/topics?cat=${c.id}`} onClick={(e) => { if (plainClick(e)) onClose(false); }}>{c.name}</Link>)}</li>,
      <li key="h">{L('/trending', '热门文章')}</li>,
      <li key="s"><button type="button" className="lm-m-a" onClick={onSearch}>搜索你的处境</button></li>,
    ]],
    ['找人', 'PEOPLE', [<li key="p">{L('/people', '人物资料库')}</li>, <li key="r">{L('/#section-people', '推荐分享者', '首页')}</li>, <li key="b">{L('/bookings', '预约一对一')}</li>]],
    ['写经验', 'SHARE', [<li key="w">{L(writeTo, '写一段决策经历', '需北大邮箱验证')}</li>, <li key="m">{L('/me', '我的内容管理')}</li>]],
    ['我的', 'MINE', [<li key="l">{L('/library', '关注、推荐与收藏')}</li>, <li key="b">{L('/bookings', '我的预约')}</li>, <li key="n">{L('/notifications', '通知')}</li>, ...(user ? [] : [<li key="g">{L('/login', '登录／注册')}</li>])]],
    ['关于鹿鸣', 'ABOUT', [<li key="a">{L('/about', '品牌故事')}</li>]],
  ];
  return (
    <div className={`lm-menu${on ? ' on' : ''}`} id="lm-menu">
      <div className="lm-m-scrim" onClick={() => onClose(true)} />
      <div className="lm-m-strip" aria-hidden="true"><span className="lm-m-v">问前路 找鹿鸣</span><img className="lm-m-logo" src={SITE_IMAGES.logo_light.url} alt="" /></div>
      <nav ref={panel} className="lm-m-panel" role="dialog" aria-modal="true" aria-label="网站选单">
        <button className="lm-m-close" type="button" aria-label="关闭选单" onClick={() => onClose(true)}><i /><i /></button>
        <div className="lm-m-cols">
          {COLS.map(([zh, en, items]) => (
            <section key={en} className="lm-m-col">
              <div className="lm-m-h"><span className="lm-m-zh">{zh}</span><span className="lm-m-en">{en}</span></div>
              <ul className="lm-m-list">{items}</ul>
            </section>
          ))}
        </div>
        <div className="lm-m-foot"><span>分享者都经过北大邮箱验证，每一位都找得到</span></div>
      </nav>
    </div>
  );
}

export default function Header() {
  const { user, logout, unreadCount } = useAppState();
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();
  const openSearch = useSearchModal();
  const [menuOpen, setMenuOpen] = useState(false);
  const burger = useRef(null);
  const me = user?.personId ? getPerson(user.personId) : null;
  // 写文章：未登录 → 登录；没验证北大邮箱 → 我的内容管理（先验证）
  const writeTo = !user ? '/login' : user.pkuVerified ? '/write' : '/me';

  useEffect(() => { setMenuOpen(false); }, [pathname, search, hash]);  // 换页就关选单
  const closeMenu = (focusBack) => { setMenuOpen(false); if (focusBack) burger.current?.focus({ preventScroll: true }); };

  return (
    <>
      <header className="lm-top">
        <div className="lm-wrap lm-top-in">
          <div className="lm-left">
            <button ref={burger} className="lm-burger" type="button" aria-expanded={menuOpen} aria-controls="lm-menu" aria-label={menuOpen ? '关闭选单' : '打开选单'} onClick={() => setMenuOpen((v) => !v)}><i /><i /><i /></button>
          </div>
          <Link className="lm-brand" to="/"><Brand /></Link>
          <div className="lm-right">
            <button className="lm-icon" type="button" aria-label="搜索" onClick={(e) => openSearch({ from: e.currentTarget })}><SearchIcon /></button>
            {user && (
              <Link className="lm-icon" to="/notifications" aria-label={unreadCount ? `通知（${unreadCount} 则未读）` : '通知'}>
                <BellIcon />{unreadCount > 0 && <span className="lm-badge">{unreadCount}</span>}
              </Link>
            )}
            <Link className="lm-hlink lm-write" to={writeTo}>写文章</Link>
            {user ? <UserMenu user={user} me={me} onGo={navigate} onLogout={() => { logout(); navigate('/login'); }} />
              : (
                <Link className="lm-login" to="/login">登录<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 9 9 3M4.5 3H9v4.5" strokeLinecap="round" strokeLinejoin="round" /></svg></Link>
              )}
          </div>
        </div>
      </header>
      <Menu open={menuOpen} onClose={closeMenu} burger={burger} writeTo={writeTo} user={user}
        onSearch={() => { setMenuOpen(false); setTimeout(() => openSearch({ from: burger.current }), reduced() ? 0 : 400); }} />
    </>
  );
}
