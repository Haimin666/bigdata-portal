// 网关配置:唯一配置源 server/config.local.json(gitignore 不入库),
// 缺失字段回退到环境变量 / 默认值(兼容旧部署,运行时不再读取 .env.local)。

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// ── 1. 读 JSON 配置文件(不存在则空对象)──────────────────────
const cfgFile = path.join(import.meta.dirname, 'config.local.json')
let fileCfg = {}
if (existsSync(cfgFile)) {
  try {
    fileCfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
  } catch (e) {
    // 配置解析失败必须启动即报错,不能静默回退(否则 dbProxyUrl/dsToken 等全丢,
    // 功能悄悄失效且 auth 会被意外打开)。常见原因:JSON 布尔写成 True/False(应为小写 true/false)。
    throw new Error(`[config] 解析 ${cfgFile} 失败:${e.message} —— 请修正该文件后再启动(注意 JSON 布尔必须小写 true/false,不能写 True/False)`)
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
  // iframe 代理白名单(主机后缀,以 . 开头 = 后缀匹配;用于 NM 日志等动态主机)
  yarnProxyAllowHosts: pick(fileCfg.yarnProxyAllowHosts, 'YARN_PROXY_ALLOW_HOSTS', '.bigdata.shiqiao.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  hdfsUrl: pick(fileCfg.hdfsUrl, 'HDFS_URL', 'http://hadoop-nn-1.bigdata.shiqiao.com:9870'),
  dsWebUrl: pick(fileCfg.dsWebUrl, 'DS_WEB_URL', 'http://olds.bigdata.shiqiao.com/dolphinscheduler'),
  // 邮件 Web 反代(经 Windows 节点 portproxy 中转):配置后注册 /apps/mail/* 子应用
  mailProxyUrl: pick(fileCfg.mailProxyUrl, 'MAIL_PROXY_URL', ''),
  omdUrl: pick(fileCfg.omdUrl, 'OMD_URL', 'https://omd.corp.shiqiao.com'),
  stingrayUrl: pick(fileCfg.stingrayUrl, 'STINGRAY_URL', 'http://stingray.corp.shiqiao.com'),
  jupyterUrl: pick(fileCfg.jupyterUrl, 'JUPYTER_URL', 'http://127.0.0.1:8888'),
  dsToken: pick(fileCfg.dsToken, 'DS_TOKEN', ''),
  dbProxyUrl: pick(fileCfg.dbProxyUrl, 'DB_PROXY_URL', ''),
  dbProxyToken: pick(fileCfg.dbProxyToken, 'DB_PROXY_TOKEN', ''),
  assistantUrl: pick(fileCfg.assistantUrl, 'ASSISTANT_URL', 'http://127.0.0.1:8787'),
  assistantToken: pick(fileCfg.assistantToken, 'ASSISTANT_TOKEN', ''),
  assistantWorkspace: pick(fileCfg.assistantWorkspace, 'ASSISTANT_WORKSPACE', ''),
  // db-proxy 写解锁共享密钥:与客户机 datasources.json 的 spark.writeToken 一致。
  // 门户在写操作解锁后附加 X-Spark-Write 头,db-proxy 侧校验后才放行写(双保险)。
  dbProxyWriteToken: pick(fileCfg.dbProxyWriteToken, 'DB_PROXY_WRITE_TOKEN', ''),
  // Livy(Spark SQL)地址:数据库查询的 sparksql 引擎经 /api/spark/query 走这里
  livyUrl,
  livy,
  // Spark SQL 写操作解锁密码(类似 Jupyter 登录)。
  // 未配置(空)时写语句(INSERT/CREATE/DROP/ALTER/TRUNCATE 等)一律禁止,只允许只读查询。
  sparkWritePassword: pick(fileCfg.sparkWritePassword, 'SPARK_WRITE_PASSWORD', ''),
  // 存储路径(默认项目内 data/,docker 挂载 ./data:/app/data 自动对齐)
  dbScriptsDir: pick(fileCfg.dbScriptsDir, 'DB_SCRIPTS_DIR', path.join(import.meta.dirname, '../data/scripts')),
  dsDepsCacheFile: pick(fileCfg.dsDepsCacheFile, 'DS_DEPS_CACHE_FILE', path.join(import.meta.dirname, '../data/ds-deps.json')),
  dsDepsRefreshInterval: pickInt(fileCfg.dsDepsRefreshInterval, 'DS_DEPS_REFRESH_INTERVAL', 24 * 60 * 60 * 1000),
  // 前端模块显隐:白名单(菜单 name 列表,如 ["yarn","hdfs","dbQuery"])。
  // 缺省(空/未配置)表示全部模块展示;配置后仅展示名单内模块。
  enabledModules: Array.isArray(fileCfg.enabledModules) ? fileCfg.enabledModules.map(String) : [],
  // 认证(用户管理):默认开启;首次启动无用户时引导创建管理员
  authEnabled: pickBool(fileCfg.auth?.enabled, 'AUTH_ENABLED', true),
  authSessionHours: pickInt(fileCfg.auth?.sessionHours, 'AUTH_SESSION_HOURS', 12),
  // 反代层数:0 = 不信任(本地直连);生产 nginx 反代时设 1,登录/解锁限速按真实客户端 IP 计
  trustProxy: pickInt(fileCfg.trustProxy, 'TRUST_PROXY', 0),
  // DataLeap 发布到 DS 的目标项目(固定一个测试项目,不污染原始项目)
  dataleapPublishProject: pick(fileCfg.dataleapPublishProject, 'DATALEAP_PUBLISH_PROJECT', 'whm-test')
}
