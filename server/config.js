// 网关配置:全部目标地址由环境变量驱动,便于独立部署

// ── 加载项目根 .env.local(零依赖)──────────────────────────────
// 仅填充未设置的环境变量:shell 显式 export 的优先于 .env.local。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const envFile = path.join(import.meta.dirname, '../.env.local')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
}

const DEFAULT_RM = 'http://hadoop-nn-1.bigdata.shiqiao.com:8088'

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  resourceManagers: (process.env.YARN_RM_LIST || DEFAULT_RM)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  hdfsUrl: process.env.HDFS_URL || 'http://hadoop-nn-1.bigdata.shiqiao.com:9870',
  dsWebUrl: process.env.DS_WEB_URL || 'http://olds.bigdata.shiqiao.com/dolphinscheduler',
  omdUrl: process.env.OMD_URL || 'https://omd.corp.shiqiao.com',
  stingrayUrl: process.env.STINGRAY_URL || 'http://stingray.corp.shiqiao.com',
  // 海豚 API token(配置项,不进前端):所有 /dolphinscheduler 请求由网关注入该 header,
  // 项目列表即该 token 用户可见的项目,天然不存在无权限项目
  dsToken: process.env.DS_TOKEN || '',
  // 客户机 DB 代理服务地址(如 http://客户机IP:8756),空则 /api/db 代理不可用
  dbProxyUrl: process.env.DB_PROXY_URL || '',
  // db-proxy 鉴权 token(与客户机 datasources.json 的 authToken 一致),
  // 由网关注入 X-DB-Token 请求头,前端不感知
  dbProxyToken: process.env.DB_PROXY_TOKEN || ''
}
