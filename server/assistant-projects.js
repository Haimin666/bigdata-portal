/**
 * 开发助手 · 项目制(A+B 方案)
 *
 * 项目 = 门户侧分组概念 + 8787 workspace 下的工作目录:
 *  - 项目元数据存 data/assistant-projects.json(门户自管)
 *  - 配置 assistantWorkspace(宿主 workspace 路径)时,新建项目自动建 projects/<name>/ 目录;
 *    未配置则跳过建目录,前端发消息时注入目录指令,由 agent 自己建。
 *  - 会话归属项目(sessionProjects 映射),前端按项目过滤会话。
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.join(import.meta.dirname, '../data')
const FILE = path.join(DATA_DIR, 'assistant-projects.json')

function genId() {
  return `p_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return { projects: [], sessionProjects: {} }
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

/** workspace 相对目录名(安全:只允许字母数字下划线连字符中文) */
export function sanitizeDir(name) {
  const n = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_')
  return n || 'untitled'
}

export function createAssistantProjectsRoutes({ workspaceRoot }) {
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
      if (workspaceRoot) {
        try {
          fs.mkdirSync(path.join(workspaceRoot, 'projects', dir), { recursive: true })
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

    /** POST /api/assistant/projects/:id/upload {name, contentBase64} 上传文件到项目目录 */
    upload(id, name, contentBase64) {
      const data = load()
      const proj = data.projects.find((p) => p.id === id)
      if (!proj) throw Object.assign(new Error('项目不存在'), { status: 404 })
      if (!workspaceRoot) throw Object.assign(new Error('未配置 assistantWorkspace,无法写入项目目录'), { status: 503 })
      const base = path.join(workspaceRoot, 'projects', proj.dir)
      // 目录不存在则尝试创建(失败降级抛错)
      fs.mkdirSync(base, { recursive: true })
      const filename = path.basename(String(name || '').trim()) || `upload_${Date.now()}`
      const abs = path.join(base, filename)
      // 防路径穿越:basename 已隔离;再校验最终路径在 base 内
      if (!abs.startsWith(base)) throw Object.assign(new Error('非法文件名'), { status: 400 })
      const buf = Buffer.from(contentBase64 || '', 'base64')
      if (!buf.length) throw Object.assign(new Error('空文件'), { status: 400 })
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
