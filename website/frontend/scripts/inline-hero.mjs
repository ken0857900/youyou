// 单档版：把 /hero/*.svg 换成 data URI（public 资料夹的图 viteSingleFile 塞不进去）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = 'dist-single/index.html';
const html = readFileSync(out, 'utf8')
  .replace(/\/hero\/(hero-\d+\.svg)/g, (_, f) =>
    `data:image/svg+xml;base64,${readFileSync(`public/hero/${f}`).toString('base64')}`)
  .replace(/(?:\.\/|\/)favicon\.svg/g, `data:image/svg+xml;base64,${readFileSync('public/favicon.svg').toString('base64')}`);
writeFileSync(out, html);
const preview = new URL('../../../预览/PathFinder预览.html', import.meta.url);
mkdirSync(new URL('.', preview), { recursive: true });
writeFileSync(preview, html);
console.log('已同步更新 预览/PathFinder预览.html');
