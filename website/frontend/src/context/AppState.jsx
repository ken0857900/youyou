import { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../data/api';

// 读者互动状态放 Context；有后端时同时打 API（api.js 负责退回 mock）
const AppStateContext = createContext(null);

export function AppStateProvider({ children }) {
  const [user, setUser] = useState(() => api.restore()); // null = 未登录；重新整理时从 localStorage 恢复
  const [following, setFollowing] = useState({});
  const [bookmarked, setBookmarked] = useState({});
  const [starred, setStarred] = useState({});
  const [bookings, setBookings] = useState([]);
  const [notifications, setNotifications] = useState([]); // 没登录不显示通知（登录后 enter 拉）
  const navigate = useNavigate();
  const reset = () => { setUser(null); setStarred({}); setBookmarked({}); setFollowing({}); setBookings([]); setNotifications([]); };
  useEffect(() => api.setOnExpired(reset), []);

  // 登录后拉通知和「我的」；演示登录、验证码登录、重新整理恢复都走这里
  const enter = async (acc) => {
    await api.ensurePerson(acc.personId).catch(() => {});
    setUser(acc); setNotifications(await api.notifications());
    const m = await api.mine();
    if (m) { setStarred(m.starred); setBookmarked(m.bookmarked); setFollowing(m.following); setBookings(m.bookings); }
  };
  useEffect(() => { if (user) enter(user); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 关注／收藏／推荐：没登录一律先去登录（所有按钮都走这里，不用每个页面各自挡）
  const toggle = (setter, remote) => (id) => {
    if (!user) return navigate('/login');
    const flip = () => setter((prev) => ({ ...prev, [id]: !prev[id] }));
    flip();
    remote?.(id).catch((e) => { flip(); alert(e.message); }); // 后端没存成：画面翻回来
  };
  // 写入失败：说原因，不改画面
  const tryWrite = (fn) => async (...args) => { try { await fn(...args); } catch (e) { alert(e.message); } };

  const value = {
    user,
    login: async (role = 'sharer') => enter(await api.login(role)),
    loginWithCode: async (email, code, password) => enter(await api.verifyCode(email, code, password)),
    loginWithPassword: async (email, password) => enter(await api.passwordLogin(email, password)),
    upgradePku: async (email, code) => { const acc = await api.pkuVerify(email, code); await api.ensurePerson(acc.personId); setUser(acc); },
    logout: () => { api.logout(); reset(); },
    following, toggleFollow: toggle(setFollowing, api.toggleFollow),
    bookmarked, toggleBookmark: toggle(setBookmarked, api.toggleBookmark),
    starred, toggleStar: toggle(setStarred, api.toggleStar),
    markPaid: tryWrite(async (b) => { const saved = await api.markPaid(b); setBookings((prev) => prev.map((x) => (x.id === b.id ? saved : x))); }),
    completeReview: tryWrite(async (b, stars, comment) => { const saved = await api.completeReview(b, stars, comment); setBookings((prev) => prev.map((x) => (x.id === b.id ? saved : x))); }),
    bookings, addBooking: async (b) => { const saved = await api.addBooking(b); setBookings((prev) => [saved, ...prev]); },
    notifications,
    unreadCount: notifications.filter((n) => !n.read).length,
    markRead: (id) => { api.markRead(id).catch(() => {}); setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n))); }, // 已读没存成无伤，下次进来还是未读
    markAllRead: () => { notifications.filter((n) => !n.read).forEach((n) => api.markRead(n.id).catch(() => {})); setNotifications((prev) => prev.map((n) => ({ ...n, read: true }))); },
    addNotification: (n) => setNotifications((prev) => [{ id: `n${Date.now()}`, read: false, ...n }, ...prev]),
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

// oxlint-disable-next-line react/only-export-components -- hook 跟 Provider 放一起
export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState 要包在 <AppStateProvider> 里面用');
  return ctx;
}

