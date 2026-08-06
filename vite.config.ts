import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 本地开发时所有 /api、/apps 等请求代理到 Express 网关(server/index.js)。
// 默认 http://localhost:3000,可用环境变量 GATEWAY_URL 覆盖(如指向远程网关)。
const gateway = process.env.GATEWAY_URL || 'http://localhost:3000'
const gatewayProxy = {
  target: gateway,
  changeOrigin: true,
  // WebSocket 支持(Stingray SQL 查询结果经 ws 实时推送)
  ws: true
}

export default defineConfig({
  plugins: [vue()],
  css: {
    preprocessorOptions: {
      scss: {
        // 使用 Dart Sass 现代 Compiler API,避免 legacy-js-api 弃用警告(需 sass >= 1.70)
        api: 'modern-compiler',
        additionalData: `@use "@/styles/variables.scss" as *;`
      }
    }
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 3002,
    host: true,
    proxy: {
      '/hadoopapi': gatewayProxy,
      '/apps': gatewayProxy,
      '/stingray-static': gatewayProxy,
      '/__/stingray': gatewayProxy,
      '/api': gatewayProxy,
      '/webhdfs': gatewayProxy,
      // HDFS 磁盘总览经 /static 代理 NameNode JMX,dev 下需转发到网关
      '/static': gatewayProxy,
      // 海豚调度子应用资源/API 为绝对路径 /dolphinscheduler/*,同样反代到网关
      '/dolphinscheduler': gatewayProxy
    }
  }
})
