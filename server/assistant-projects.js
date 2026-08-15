/**
 * 开发助手 · 项目制(A+B 方案)
 *
 * 项目 = 门户侧分组概念 + 8787 workspace 下的工作目录:
 *  - 项目元数据存 data/assistant-projects.json(门户自管)
 *  - 配置 assistantWorkspace(宿主 workspace 路径)时,新建项目自动建 projects/<name>/ 目录;
 *    未配置则跳过建目录,前端发消息时注入目录指令,由 agent 自己建。
 *  - 会话归属项目(sessionProjects 映射),前端按项目过滤会话。
 *
 * 安全:所有落盘路径统一经 _resolve() 做 resolve + relative 校验,防 ../ 逃逸;
 * 项目目录名 sanitizeDir 拒绝 '.'/'..'。
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.join(import.meta.dirname, '../data')
const FILE = path.join(DATA_DIR, 'assistant-projects.json')
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 与前端 10MB 对齐,后端强校验

function genId() {
  return `p_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

// 原子写:先写 .tmp 再 rename,崩溃不留半截 JSON
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, FILE)
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return { projects: [], sessionProjects: {} }
  }
}

/** workspace 相对目录名(安全:只允许字母数字下划线连字符中文,拒绝 . 与 ..) */
export function sanitizeDir(name) {
  const n = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_')
  if (!n) return 'untitled'
  if (n === '.' || n === '..') throw Object.assign(new Error('非法的项目名称'), { status: 400 })
  return n
}

export function createAssistantProjectsRoutes({ workspaceRoot }) {
  // projects 根目录(绝对路径),所有项目目录必须在其下
  const projectsRoot = workspaceRoot ? path.resolve(workspaceRoot, 'projects') : null

  /** 项目绝对路径 + 逃逸强校验:resolved 必须在 projectsRoot 内 */
  function _resolve(id, rel = '') {
    if (!projectsRoot) throw Object.assign(new Error('未配置 assistantWorkspace,无法操作项目文件'), { status: 503 })
    const data = load()
    const proj = data.projects.find((p) => p.id === id)
    if (!proj) throw Object.assign(new Error('项目不存在'), { status: 404 })
    const base = path.resolve(projectsRoot, proj.dir)
    if (base !== projectsRoot && !base.startsWith(projectsRoot + path.sep)) {
      throw Object.assign(new Error('项目目录非法'), { status: 400 })
    }
    const parts = _safeRel(rel)
    const target = path.resolve(base, ...parts)
    // 双重防线:relative 必须以 base 开头(禁止 ../ 逃逸)
    const relPath = path.relative(base, target)
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
      throw Object.assign(new Error('非法路径'), { status: 400 })
    }
    return { proj, base, target, parts }
  }

  /** 相对路径安全:禁止 .. 与绝对路径 */
  function _safeRel(rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\//, '')
    const parts = clean.split('/').filter((x) => x && x !== '.')
    if (parts.some((x) => x === '..')) throw Object.assign(new Error('非法路径'), { status: 400 })
    return parts
  }

  return {
    /** GET /api/assistant/projects */
    list() {
      const data = load()
      return { code: 0, data: { projects: data.projects, sessionProjects: data.sessionProjects } }
    },

    /** POST /api/assistant/projects {name} */
    create(name) {
      const data = load()
      const dir = sanitizeDir(name)
      const dup = data.projects.some((p) => p.dir === dir)
      if (dup) throw Object.assign(new Error('项目已存在'), { status: 409 })
      const proj = {
        id: genId(),
        name: String(name || '').trim() || dir,
        dir,
        createdAt: Date.now()
      }
      // 配置了 workspace 路径 → 门户自动建项目目录;
      // 失败(mac 沙箱/权限)降级:只存元数据,目录由 agent 按前端注入的工作目录指令自建
      let dirCreated = false
      if (projectsRoot) {
        try {
          const target = path.resolve(projectsRoot, dir)
          if (target === projectsRoot || !target.startsWith(projectsRoot + path.sep)) {
            throw new Error('bad dir')
          }
          fs.mkdirSync(target, { recursive: true })
          dirCreated = true
        } catch {
          /* 降级 */
        }
      }
      proj.dirCreated = dirCreated
      data.projects.push(proj)
      save(data)
      return { code: 0, data: proj }
    },

    /** DELETE /api/assistant/projects/:id */
    remove(id) {
      const data = load()
      const idx = data.projects.findIndex((p) => p.id === id)
      if (idx === -1) return { code: 0, data: true }
      const [removed] = data.projects.splice(idx, 1)
      for (const k of Object.keys(data.sessionProjects)) {
        if (data.sessionProjects[k] === id) delete data.sessionProjects[k]
      }
      save(data)
      // 不删除目录(保留用户文件),仅解绑
      return { code: 0, data: { id: removed.id } }
    },

    /** GET /api/assistant/projects/:id/files 列出项目目录 */
    listFiles(id, rel = '') {
      const { target } = _resolve(id, rel)
      const entries = []
      try {
        for (const name of fs.readdirSync(target)) {
          const abs = path.join(target, name)
          let st
          try {
            st = fs.statSync(abs)
          } catch {
            continue
          }
          entries.push({
            name,
            path: rel ? `${rel.replace(/\/$/, '')}/${name}` : name,
            type: st.isDirectory() ? 'dir' : 'file',
            size: st.isDirectory() ? 0 : st.size
          })
        }
      } catch {
        /* 目录不存在返回空 */
      }
      return { code: 0, data: { entries } }
    },

    /** GET /api/assistant/projects/:id/file?rel= 读取文件内容(文本) */
    readFile(id, rel = '') {
      const { target, base } = _resolve(id, rel)
      if (target === base || !fs.statSync(target).isFile()) {
        throw Object.assign(new Error('不是文件'), { status: 400 })
      }
      // 只允许文本类扩展名,避免把二进制当文本渲染/泄漏
      const ext = path.extname(target).toLowerCase()
      const BINARY = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.zip', '.gz', '.tar', '.jar', '.pdf', '.xlsx', '.docx', '.parquet', '.orc']
      if (BINARY.includes(ext)) {
        return { code: 0, data: { binary: true, path: rel, size: fs.statSync(target).size } }
      }
      const content = fs.readFileSync(target, 'utf8')
      return { code: 0, data: { binary: false, path: rel, size: Buffer.byteLength(content), content } }
    },

    /** POST /api/assistant/projects/:id/dir {rel, name} 新建文件夹 */
    mkdir(id, rel, name) {
      const { target } = _resolve(id, rel)
      const n = _safeRel(name).join('')
      if (!n) throw Object.assign(new Error('名称不能为空'), { status: 400 })
      const dir = path.join(target, n)
      try {
        fs.mkdirSync(dir, { recursive: false })
      } catch (e) {
        if (e.code === 'EEXIST') throw Object.assign(new Error('目录已存在'), { status: 409 })
        throw e
      }
      return { code: 0, data: { path: rel ? `${rel.replace(/\/$/, '')}/${n}` : n } }
    },

    /** POST /api/assistant/projects/:id/file {rel, name, content} 新建文件(已存在返回 409) */
    createFile(id, rel, name, content = '') {
      const { target } = _resolve(id, rel)
      const n = _safeRel(name).join('')
      if (!n) throw Object.assign(new Error('名称不能为空'), { status: 400 })
      const file = path.join(target, n)
      if (fs.existsSync(file)) throw Object.assign(new Error('文件已存在'), { status: 409 })
      fs.mkdirSync(path.dirname(file), { recursive: true }) // 支持子目录不存在时自动创建
      fs.writeFileSync(file, String(content ?? ''))
      return { code: 0, data: { path: rel ? `${rel.replace(/\/$/, '')}/${n}` : n } }
    },

    /** DELETE /api/assistant/projects/:id/file?rel= 删除文件或空目录 */
    removeFile(id, rel = '') {
      const { target, base } = _resolve(id, rel)
      if (target === base) throw Object.assign(new Error('不能删除项目根目录'), { status: 400 })
      if (!fs.existsSync(target)) throw Object.assign(new Error('不存在'), { status: 404 })
      const st = fs.statSync(target)
      if (st.isDirectory()) {
        const items = fs.readdirSync(target)
        if (items.length) throw Object.assign(new Error('目录非空,请先删除子项'), { status: 409 })
        fs.rmdirSync(target)
      } else {
        fs.unlinkSync(target)
      }
      return { code: 0, data: { path: rel } }
    },

    /** PATCH /api/assistant/projects/:id/file {rel, name, newName} 重命名/移动 */
    renameFile(id, rel = '', name, newName) {
      const { target } = _resolve(id, rel)
      const from = path.join(target, _safeRel(name).join(''))
      const to = path.join(target, _safeRel(newName).join(''))
      if (!fs.existsSync(from)) throw Object.assign(new Error('不存在'), { status: 404 })
      if (fs.existsSync(to)) throw Object.assign(new Error('目标已存在'), { status: 409 })
      fs.renameSync(from, to)
      return { code: 0, data: { path: rel ? `${rel.replace(/\/$/, '')}/${_safeRel(newName).join('')}` : _safeRel(newName).join('') } }
    },

    /** POST /api/assistant/projects/:id/upload {name, contentBase64} 上传文件(同名 409,超限 413) */
    upload(id, name, contentBase64) {
      const { proj, base } = _resolve(id, '')
      const filename = path.basename(String(name || '').trim()) || `upload_${Date.now()}`
      // base64 严格校验,避免静默损坏
      const b64 = String(contentBase64 || '').trim()
      if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw Object.assign(new Error('无效的上传内容'), { status: 400 })
      const buf = Buffer.from(b64, 'base64')
      if (!buf.length) throw Object.assign(new Error('空文件'), { status: 400 })
      if (buf.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error(`文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限`), { status: 413 })
      const abs = path.join(base, filename)
      if (fs.existsSync(abs)) throw Object.assign(new Error('同名文件已存在'), { status: 409 })
      try {
        fs.writeFileSync(abs, buf)
      } catch (e) {
        if (e.code === 'EPERM' || e.code === 'EACCES') {
          throw Object.assign(
            new Error('门户进程无权限写入 workspace 项目目录(生产环境需将门户容器挂载同一 workspace 卷);可改用消息让 agent 创建文件'),
            { status: 503 }
          )
        }
        throw e
      }
      return { code: 0, data: { path: `projects/${proj.dir}/${filename}`, size: buf.length } }
    },

    /** PUT /api/assistant/projects/session {sessionId, projectId} 关联会话到项目 */
    bindSession(sessionId, projectId) {
      const data = load()
      if (projectId) {
        if (!data.projects.some((p) => p.id === projectId)) throw Object.assign(new Error('项目不存在'), { status: 404 })
        data.sessionProjects[sessionId] = projectId
      } else {
        delete data.sessionProjects[sessionId]
      }
      save(data)
      return { code: 0, data: true }
    }
  }
}
