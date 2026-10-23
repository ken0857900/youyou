// 正式站的后备资料：从线上 API 抓人物＋文章（含全文、保鲜度）存成 public/fallback.json。
// 正式站连不上后端时 boot() 读这份（参赛版只有光华示例），不退回开发用的 mock.js。
// 用法（website/frontend）：node scripts/snapshot-fallback.mjs [网站，预设 http://47.93.125.3]；线上资料改了就重跑
import fs from 'node:fs';
const base = process.argv[2] || 'http://47.93.125.3';
const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
const [persons, lite, wishes] = await Promise.all([get('/api/persons'), get('/api/articles?lite=1'), get('/api/wishes')]);
const articles = [];
for (let i = 0; i < lite.length; i += 10) articles.push(...await Promise.all(lite.slice(i, i + 10).map((a) => get(`/api/articles/${a.id}`))));
fs.writeFileSync(new URL('../public/fallback.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), persons, articles, wishes }));
console.log(`${persons.length} 人、${articles.length} 篇、保鲜度 ${articles.reduce((n, a) => n + (a.claims?.length || 0), 0)} 句`);
