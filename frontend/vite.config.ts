import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createReadStream, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { createRequire } from 'node:module'

// PDF.js 的附属资源保持原始文件名；生产和开发都从本站读取，不依赖 CDN。
function pdfAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const files = new Map<string, string>()
  for (const dir of ['cmaps', 'standard_fonts', 'wasm'])
    for (const name of readdirSync(join(root, dir))) files.set(`${dir}/${name}`, join(root, dir, name))
  return {
    name: 'local-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const file = files.get((req.url || '').split('?')[0].replace(/^\//, ''))
        if (!file) return next()
        res.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const [name, file] of files) this.emitFile({ type: 'asset', fileName: `pdfjs/${name}`, source: readFileSync(file) })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), pdfAssets()],
  // 首次上传才启动 MD5 Worker；提前优化它的 CommonJS 依赖，避免运行中
  // 新增优化依赖触发整页 reload，导致上传状态和文件选择丢失。
  optimizeDeps: {
    include: ['spark-md5', 'pdfjs-dist', 'pdfjs-dist/web/pdf_viewer.mjs'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      }
    }
  }
})
