import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './luming.css'
import './list.css'
import App from './App.jsx'
import { boot } from './data/api'

// 宋体网页字体（思源宋体同一套字形的 Noto Serif SC，切成小块，只下载页面用到的字；字体档跟网站一起放，不连 Google Fonts）
// 单档版（build:single）不带，不然一个档会塞进几十 MB 字体
if (import.meta.env.MODE !== 'single') {
  import('@fontsource/noto-serif-sc/400.css')
  import('@fontsource/noto-serif-sc/600.css')
  import('@fontsource/noto-serif-sc/900.css')
}

// 先试后端拿资料（连不上就用 mock），再渲染
boot().then(() => createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
))
