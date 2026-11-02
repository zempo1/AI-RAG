import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  // 首次上传才启动 MD5 Worker；提前优化它的 CommonJS 依赖，避免运行中
  // 新增优化依赖触发整页 reload，导致上传状态和文件选择丢失。
  optimizeDeps: {
    include: ['spark-md5'],
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
