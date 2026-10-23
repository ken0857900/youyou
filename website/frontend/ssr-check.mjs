// npm run check：在 node 里把主要页面渲染一次，会抛错（＝线上白屏）就失败。改前端后、部署前跑
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const req = createRequire(import.meta.url);
const React = req('react');
const { renderToString } = req('react-dom/server');
const { MemoryRouter, Routes, Route } = await import(pathToFileURL(req.resolve('react-router-dom')).href);
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { AppStateProvider } = await vite.ssrLoadModule('/src/context/AppState.jsx');
const h = React.createElement;

// [网址, 路由, 页面]；搜索要有「没有起点比你好群」的问句（10/21 白屏就是这种）
const PAGES = [
  ['/search?q=我不知道要不要继续考研', '/search', 'SearchPage'],
  ['/search?q=双非计算机考研失败怎么办', '/search', 'SearchPage'],
  ['/search?q=211 大三 保研还是考研', '/search', 'SearchPage'],
  ['/', '/', 'HomePage'],
  ['/people', '/people', 'PeoplePage'],
  ['/topics', '/topics', 'TopicsPage'],
  ['/trending', '/trending', 'TrendingPage'],
  ['/articles/a1', '/articles/:id', 'ArticlePage'],
  ['/people/p1', '/people/:id', 'PersonPage'],
  ['/login', '/login', 'LoginPage'],
];
let bad = 0;
for (const [url, path, name] of PAGES) {
  const Page = (await vite.ssrLoadModule(`/src/pages/${name}.jsx`)).default;
  try {
    renderToString(h(MemoryRouter, { initialEntries: [url] }, h(AppStateProvider, null, h(Routes, null, h(Route, { path, element: h(Page) })))));
    console.log('OK  ', url);
  } catch (e) { bad++; console.log('FAIL', url, '→', e.message); }
}
// 保鲜度标色：假数据没有 claims，单独渲染四种状态＋一句空白不同（容许空白不同也标得到）
const ArticleBody = (await vite.ssrLoadModule('/src/components/ArticleBody.jsx')).default;
const claim = (sentence, status, year) => ({ sentence, status, year, reason: 'r', quote: 'q\n原文', noticeUrl: 'http://x', noticeTitle: 't' });
try {
  const out = renderToString(h(ArticleBody, { text: '甲句。乙句。\n\n丙句。\n\n丁 句。', claims: [
    claim('甲句。', 'changed', 2026), claim('乙句。', 'valid', 2026), claim('丙句。', 'pending', 2025), claim('丁句。', 'unknown', null)] }));
  // 旁注式：依据点句子才出现，这里检查四句都标到（含空白不同的「丁 句」）、摘要数字、引导文字
  if ((out.match(/<mark/g) || []).length !== 4 || !out.includes('1 项已变更') || !out.includes('点击文章中有标记的文字')) throw new Error('标色没渲染出来');
  console.log('OK   ArticleBody 保鲜度');
} catch (e) { bad++; console.log('FAIL ArticleBody 保鲜度 →', e.message); }
await vite.close();
process.exit(bad ? 1 : 0);
