// bigdata-portal 磁盘检测服务(独立进程,服务器本机运行)
//
// 职责:下载 NameNode FsImage → 用官方 hdfs oiv 转 Delimited(TSV)→ 流式解析
//       全量文件 → 只保留 Top 大/小文件缓存 → 供门户 /api/hdfs/scan、/api/hdfs/delete 调用。
// 说明:仅手动触发解析(点击"检测大/小文件"时),解析期间并发请求等待同一结果。
//
// 依赖:hadoop 客户端(hdfs oiv)。未安装时启动会提示,但服务仍可启动(请求返回错误)。
//
// 契约:
//   GET  /scan   → { code:0, data:{ scanTime, files:[{path,size,blocks,mtime}] } }
//   POST /delete → body { path, trash:true } → { code:0 }(调用 WebHDFS DELETE)
//
// 环境变量:
//   PORT            默认 9911
//   HDFS_URL        NameNode 地址,默认 http://hadoop-nn-1.bigdata.shiqiao.com:9870
//   OIV_CMD         默认 hdfs(有 oiv 子命令);可写完整路径
//   CACHE_DIR       默认 /tmp/hdfs-scan
//   TOP_N           默认 100(Top 大/小各取 N)

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'

const PORT = parseInt(process.env.PORT || '9911', 10)
const NN = process.env.HDFS_URL || 'http://hadoop-nn-1.bigdata.shiqiao.com:9870'
const OIV_CMD = process.env.OIV_CMD || 'hdfs'
const CACHE_DIR = process.env.CACHE_DIR || '/tmp/hdfs-scan'
const TOP_N = parseInt(process.env.TOP_N || '100', 10)

mkdirSync(CACHE_DIR, { recursive: true })

// ── FsImage 下载 ─────────────────────────────────────────────
function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get(u, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 400) {
        res.resume()
        return reject(new Error(`FsImage 下载失败 HTTP ${res.statusCode}`))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('FsImage 下载超时'))
    })
  })
}

/** 拿最新 checkpoint txid(NameNodeInfo.JournalTransactionInfo.MostRecentCheckpointTxId;
 *  JMX 里该字段是 JSON 字符串,需先 parse) */
async function getCheckpointTxId() {
  const buf = await fetchText(`${NN}/jmx?qry=Hadoop:service=NameNode,name=NameNodeInfo`)
  const data = JSON.parse(buf.toString('utf8'))
  const bean = data.beans?.find((b) => (b.name ?? '').endsWith('NameNodeInfo'))
  const jti = bean?.JournalTransactionInfo
  const info = typeof jti === 'string' ? JSON.parse(jti) : jti
  return info?.MostRecentCheckpointTxId
}

/** 下载最新 FsImage 到本地(只保留最新一份;镜像大且内网可能慢,超时放宽) */
async function downloadFsImage(txid) {
  const dest = path.join(CACHE_DIR, `fsimage_${txid}.bin`)
  if (existsSync(dest)) return dest
  for (const f of readdirSync(CACHE_DIR)) {
    if (f.startsWith('fsimage_')) rmSync(path.join(CACHE_DIR, f), { force: true })
  }
  const buf = await fetchText(`${NN}/imagetransfer?getimage=1&txid=${txid}`, 300000)
  writeFileSync(dest, buf)
  return dest
}

// ── oiv 解析 → TSV → Top 文件 ────────────────────────────────
// oiv -p Delimited 输出(每行一条记录,字段含 path,  replication,  modificationTime,  accessTime,
//   preferredBlockSize,  blocksCount,  fileSize,  NS_QUOTA,  DS_QUOTA,  type,  ...)
// 其中文件(非目录)行:path 为 /xxx,fileSize 为字节。目录行 path 也出现且 fileSize 为 0。
function parseOivTsv(stdout) {
  const big = []
  const small = []
  const push = (arr, f) => {
    arr.push(f)
    if (arr.length > TOP_N) {
      // 保序裁剪:大文件按 size 降序,小文件升序
      arr.sort((a, b) => (arr === big ? b.size - a.size : a.size - b.size))
      arr.length = TOP_N
    }
  }
  for (const line of stdout.split('\n')) {
    const cols = line.split('\t')
    if (cols.length < 9) continue
    const path = cols[0]
    const type = cols[10] || ''
    const size = Number(cols[6]) || 0
    const blocks = Number(cols[5]) || 0
    const mtime = Number(cols[2]) || 0
    // 只要普通文件(非目录),且 size>0
    if (type !== 'FILE') continue
    if (size <= 0) continue
    const f = { path, size, blocks, mtime }
    push(big, f)
    push(small, f)
  }
  big.sort((a, b) => b.size - a.size)
  small.sort((a, b) => a.size - b.size)
  return { big: big.slice(0, TOP_N), small: small.slice(0, TOP_N) }
}

function runOiv(fsimagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(OIV_CMD, ['oiv', '-p', 'Delimited', '-i', fsimagePath, '-o', '/dev/stdout'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', (e) => reject(new Error(`无法执行 ${OIV_CMD} oiv:${e.message}(需安装 hadoop 客户端)`)))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`oiv 失败 code=${code}:${err.slice(0, 300)}`))
      resolve(out)
    })
  })
}

// ── 状态与缓存(仅手动触发,并发去重) ─────────────────────────
let cache = null // { scanTime, files:[...] } files 为大+小合并? 契约 files 全量 top,前端再拆
let parsing = null // Promise

async function doScan() {
  const txid = await getCheckpointTxId()
  if (!txid) throw new Error('获取 checkpoint txid 失败')
  const fsimage = await downloadFsImage(txid)
  const tsv = await runOiv(fsimage)
  const { big, small } = parseOivTsv(tsv)
  // 契约 files:大+小合并(前端按 size 再拆 top20)
  const files = [...big, ...small].sort((a, b) => b.size - a.size)
  cache = { scanTime: new Date().toISOString(), files }
  return cache
}

function scan() {
  if (cache) return Promise.resolve(cache)
  if (!parsing) {
    parsing = doScan()
      .finally(() => {
        parsing = null
      })
  }
  return parsing
}

// ── WebHDFS 删除(移回收站) ───────────────────────────────────
function webhdfsDelete(filePath, user) {
  const url = `${NN}/webhdfs/v1${encodeURIComponent(filePath)}?op=DELETE&recursive=false${user ? `&user.name=${encodeURIComponent(user)}` : ''}`
  return fetchText(url, 10000).then((buf) => {
    const d = JSON.parse(buf.toString('utf8'))
    if (!d.boolean) throw new Error('删除失败(文件不存在或无权)')
    return true
  })
}

// ── HTTP ─────────────────────────────────────────────────────
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  if (u.pathname === '/health') return sendJson(res, 200, { ok: true })
  if (u.pathname === '/scan' && req.method === 'GET') {
    scan()
      .then((c) => sendJson(res, 200, { code: 0, data: c }))
      .catch((e) => sendJson(res, 200, { code: 1, msg: e.message }))
    return
  }
  if (u.pathname === '/delete' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        return sendJson(res, 400, { code: 1, msg: 'body 需为 JSON' })
      }
      webhdfsDelete(payload.path, payload.user)
        .then(() => sendJson(res, 200, { code: 0 }))
        .catch((e) => sendJson(res, 200, { code: 1, msg: e.message }))
    })
    return
  }
  sendJson(res, 404, { code: 1, msg: 'not found' })
}).listen(PORT, () => {
  console.log(`[hdfs-scan] listening on http://127.0.0.1:${PORT} (NN=${NN}, oiv=${OIV_CMD})`)
})
