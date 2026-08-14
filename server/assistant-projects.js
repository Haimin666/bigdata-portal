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
      // 配置了 workspace 路径 → 门户自动建项目目录
      if (workspaceRoot) {
        const abs = path.join(workspaceRoot, 'projects', dir)
        fs.mkdirSync(abs, { recursive: true })
      }
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
