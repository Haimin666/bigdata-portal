import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const gateway = env.VITE_DEV_GATEWAY || 'http://127.0.0.1:3000'
  return {
    base: '/mobile/',
    plugins: [vue()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      port: 3010,
      proxy: {
        '/api': { target: gateway, changeOrigin: true },
        '/hadoopapi': { target: gateway, changeOrigin: true },
        '/yarniframe': { target: gateway, changeOrigin: true },
        '/dolphinscheduler': { target: gateway, changeOrigin: true },
        '/apps': { target: gateway, changeOrigin: true, ws: true }
      }
    },
    build: { outDir: 'dist' }
  }
})
