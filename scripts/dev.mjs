// 开发一键启动:Express 网关(server/index.js,端口 3000)+ Vite dev server(端口 3002)。
// 任一进程退出则整体退出;Ctrl+C 同时结束两个进程。
// 零第三方依赖,仅用 Node 内置 child_process。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')

const children = []
let stopping = false

function stopAll(code) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  // 留出子进程收尾时间,再退出
  setTimeout(() => process.exit(code), 300).unref()
}

function start(name, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' })
  children.push(child)
  child.on('error', (err) => {
    console.error(`[dev] 启动 ${name} 失败:${err.message}`)
    stopAll(1)
  })
  child.on('exit', (code, signal) => {
    console.log(`\n[dev] ${name} 已退出 (code=${code ?? 'null'}, signal=${signal ?? 'none'})`)
    if (!stopping) stopAll(code ?? 1)
  })
  return child
}

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))

// --no-deprecation: http-proxy@1.18.1(http-proxy-middleware 底层依赖,已停维护)内部使用
// util._extend,Node 24 启动时必打 DEP0060 警告;纯噪音,不影响功能,启动参数直接抑制。
start('网关 server/index.js (端口 3000)', ['--no-deprecation', 'server/index.js'])
start('Vite dev server (端口 3002)', [viteBin])
