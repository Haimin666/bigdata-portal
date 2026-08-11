// 网关配置:优先读 server/config.local.json(唯一配置源),
// 缺失字段回退到环境变量 / 默认值(兼容旧 .env.local 部署)。

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// ── 1. 读 JSON 配置文件(不存在则空对象)──────────────────────
const cfgFile = path.join(import.meta.dirname, 'config.local.json')
let fileCfg = {}
if (existsSync(cfgFile)) {
  try {
    fileCfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
  } catch (e) {
    console.error(`[config] 解析 ${cfgFile} 失败:${e.message},回退到环境变量`)
  }
}

// ── 2. 加载项目根 .env.local(零依赖,仅填充未设置的环境变量)────
// shell 显式 export 的优先于 .env.local。
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

// 取配置的优先级:JSON 文件 > 环境变量 > 默认值
const pick = (fileVal, envKey, defVal) => {
  if (fileVal !== undefined && fileVal !== null && fileVal !== '') return fileVal
  if (process.env[envKey] !== undefined && process.env[envKey] !== '') return process.env[envKey]
  return defVal
}
const pickBool = (fileVal, envKey, defVal) => {
  const v = pick(fileVal, envKey, undefined)
  if (v === undefined) return defVal
  return String(v).toLowerCase() === 'true'
}
const pickInt = (fileVal, envKey, defVal) => {
  const v = pick(fileVal, envKey, undefined)
  if (v === undefined) return defVal
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? n : defVal
}

const livy = fileCfg.livy || {}
// livy 地址:JSON 的 livy.{scheme,host,port} 优先;也兼容旧环境变量 LIVY_URL
const livyFromUrl = (() => {
  const u = pick(undefined, 'LIVY_URL', '')
  if (u) {
    try {
      const p = new URL(u)
      return { scheme: p.protocol.replace(':', ''), host: p.hostname, port: p.port }
    } catch { /* ignore */ }
  }
  return null
})()
const livyUrl = pick(undefined, 'LIVY_URL', '') ||
  `${livy.scheme || livyFromUrl?.scheme || 'http'}://${livy.host || livyFromUrl?.host || 'hadoop-task-1.bigdata.shiqiao.com'}:${livy.port || livyFromUrl?.port || 8998}`

// 端口特殊处理:shell/docker 显式 PORT 优先于 JSON(容器内监听端口必须可覆盖),
// 未显式设置时才用 JSON 的 port。
const envPort = process.env.PORT
const port = envPort !== undefined && envPort !== ''
  ? parseInt(envPort, 10)
  : pickInt(fileCfg.port, 'PORT', 3000)

export default {
  port,
  resourceManagers: pick(fileCfg.yarnRmList, 'YARN_RM_LIST', DEFAULT_RM)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  hdfsUrl: pick(fileCfg.hdfsUrl, 'HDFS_URL', 'http://hadoop-nn-1.bigdata.shiqiao.com:9870'),
  dsWebUrl: pick(fileCfg.dsWebUrl, 'DS_WEB_URL', 'http://olds.bigdata.shiqiao.com/dolphinscheduler'),
  omdUrl: pick(fileCfg.omdUrl, 'OMD_URL', 'https://omd.corp.shiqiao.com'),
  stingrayUrl: pick(fileCfg.stingrayUrl, 'STINGRAY_URL', 'http://stingray.corp.shiqiao.com'),
  jupyterUrl: pick(fileCfg.jupyterUrl, 'JUPYTER_URL', 'http://127.0.0.1:8888'),
  dsToken: pick(fileCfg.dsToken, 'DS_TOKEN', ''),
  dbProxyUrl: pick(fileCfg.dbProxyUrl, 'DB_PROXY_URL', ''),
  dbProxyToken: pick(fileCfg.dbProxyToken, 'DB_PROXY_TOKEN', ''),
  // Livy(Spark SQL)地址:数据库查询的 sparksql 引擎经 /api/spark/query 走这里
  livyUrl,
  livy,
  // Spark SQL 写操作解锁密码(类似 Jupyter 登录)。
  // 未配置(空)时写语句(INSERT/CREATE/DROP/ALTER/TRUNCATE 等)一律禁止,只允许只读查询。
  sparkWritePassword: pick(fileCfg.sparkWritePassword, 'SPARK_WRITE_PASSWORD', ''),
  // 各子系统登录账号(JSON 的 accounts.* 优先,兼容旧环境变量 DSWEB_USER 等)
  accounts: {
    dsWeb: {
      user: pick(fileCfg.accounts?.dsWeb?.user, 'DSWEB_USER', ''),
      pass: pick(fileCfg.accounts?.dsWeb?.pass, 'DSWEB_PASS', '')
    },
    omd: {
      user: pick(fileCfg.accounts?.omd?.user, 'OMD_USER', ''),
      pass: pick(fileCfg.accounts?.omd?.pass, 'OMD_PASS', '')
    },
    stingray: {
      user: pick(fileCfg.accounts?.stingray?.user, 'STINGRAY_USER', ''),
      pass: pick(fileCfg.accounts?.stingray?.pass, 'STINGRAY_PASS', '')
    },
    streamx: {
      user: pick(fileCfg.accounts?.streamx?.user, 'STREAMX_USER', ''),
      pass: pick(fileCfg.accounts?.streamx?.pass, 'STREAMX_PASS', '')
    }
  }
}
