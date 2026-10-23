import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// npm run build:single → dist-single/index.html：JS／CSS／图全塞进一个档，双击就能开（用示例资料，给人看画面用）
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  ...(mode === 'single' && { base: './', build: { outDir: 'dist-single' } }),
  server: { proxy: { '/api': 'http://localhost:8000', '/uploads': 'http://localhost:8000' } }, // 开发时转给 FastAPI 后端
}))
