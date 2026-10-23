import { useEffect } from 'react';
import { BrowserRouter, HashRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';

// 单档版（file:// 双击打开）没有伺服器，网址路径用 # 号
const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;
import { AppStateProvider } from './context/AppState';
import Header from './components/Header';
import Footer from './components/Footer';
import BackToTop from './components/BackToTop';
import PathDock from './components/PathDock';
import { SearchModalProvider } from './components/SearchModal';
import HomePage from './pages/HomePage';
import SearchPage from './pages/SearchPage';
import TopicsPage from './pages/TopicsPage';
import TrendingPage from './pages/TrendingPage';
import PeoplePage from './pages/PeoplePage';
import PersonPage from './pages/PersonPage';
import ArticlePage from './pages/ArticlePage';
import WritePage from './pages/WritePage';
import LoginPage from './pages/LoginPage';
import MePage from './pages/MePage';
import LibraryPage from './pages/LibraryPage';
import BookingsPage from './pages/BookingsPage';
import NotificationsPage from './pages/NotificationsPage';
import NotFoundPage from './pages/NotFoundPage';
import BrandStoryPage from './pages/BrandStoryPage';

function Layout() {
  const { pathname, hash } = useLocation();
  // 换页回到顶部；网址带 #区块（例：选单「推荐分享者」→ /#section-people）就捲到那个区块
  useEffect(() => {
    const el = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) el.scrollIntoView(); else window.scrollTo(0, 0);
  }, [pathname, hash]);

  return (
    <>
      <Header />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
      <Footer />
      <BackToTop />
      <PathDock />
    </>
  );
}

export default function App() {
  return (
    <Router>
      <AppStateProvider>
        <SearchModalProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/about" element={<BrandStoryPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/topics" element={<TopicsPage />} />
            <Route path="/trending" element={<TrendingPage />} />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/people/:id" element={<PersonPage />} />
            <Route path="/articles/:id" element={<ArticlePage />} />
            <Route path="/write" element={<WritePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/me" element={<MePage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/bookings" element={<BookingsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        </SearchModalProvider>
      </AppStateProvider>
    </Router>
  );
}
