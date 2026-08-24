// 脚本存储(数据库查询「我的目录」):SQL 脚本目录树 + 文件内容
// 存平台项目内 data/scripts/(docker 挂载 ./data:/app/data,持久化)
// 接口:/api/scripts/tree|new|rename|delete|save|get(由 index.js 挂载)
//
// 用户隔离(2026-08):目录树按用户名分桶存储,tree.json 结构
//   { "users": { "<username>": { "my": [...] }, "__shared__": { "my": [...] } } }
// - 每个用户看到两个固定根:「我的文件夹」(私有桶,仅本人可见可写)
//   和「共享文件夹」(公共桶 __shared__,所有人可见,可读/复制;增删改仅 admin)。
// - 兼容旧数据:首次加载时把旧版顶层 { my: [...] } 迁移进共享桶。
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import config from './config.js'

const SCRIPTS_DIR = config.dbScriptsDir
const TREE_FILE = path.join(SCRIPTS_DIR, 'tree.json')
const FILES_DIR = path.join(SCRIPTS_DIR, 'files')
const SHARED_KEY = '__shared__'
// 前端固定双根 id:「我的文件夹」(私有)、「共享文件夹」(公共)
const MY_ROOT_ID = '__my_root'
const SHARED_ROOT_ID = '__shared_root'

function ensureScripts() {
  fs.mkdirSync(FILES_DIR, { recursive: true })
}

/** 读原始 tree.json,自动迁移旧格式({my:[]} → 按用户分桶) */
function loadRawTree() {
  ensureScripts()
  if (!fs.existsSync(TREE_FILE)) return { users: {} }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(TREE_FILE, 'utf-8'))
  } catch {
    return { users: {} }
  }
  if (raw.users) return raw
  // 旧格式迁移:整棵树归给首个管理员(admin);无管理员信息时放 shared 由 admin 认领
  const migrated = { users: {} }
  if (Array.isArray(raw.my) && raw.my.length) {
    migrated.users[SHARED_KEY] = { my: raw.my }
  }
  saveTree(migrated)
  return migrated
}

function saveTree(tree) {
  ensureScripts()
  fs.writeFileSync(TREE_FILE, JSON.stringify(tree, null, 2), 'utf-8')
}

/**
 * 解析当前请求可见的树视图。
 * 返回 { ownerKey, nodes, canWriteShared }:nodes 固定为双根——
 * 「我的文件夹」(用户自己桶)+「共享文件夹」(__shared__ 公共桶);
 * 共享桶所有人可读,canWriteShared=true(admin)才可增删改。
 */
function resolveView(req) {
  const user = req.user || {}
  const username = String(user.username || 'anonymous')
  const isAdmin = user.role === 'admin'
  const tree = loadRawTree()

  if (!tree.users[username]) tree.users[username] = { my: [] }
  if (!tree.users[SHARED_KEY]) tree.users[SHARED_KEY] = { my: [] }

  const nodes = [
    { id: MY_ROOT_ID, name: '我的文件夹', type: 'dir', children: tree.users[username].my },
    {
      id: SHARED_ROOT_ID,
      name: '共享文件夹',
      type: 'dir',
      readonly: !isAdmin, // 非 admin 只读(打开/复制可以,增删改被后端拒绝)
      children: tree.users[SHARED_KEY].my
    }
  ]
  return { tree, ownerKey: username, nodes, canWriteShared: isAdmin }
}

/**
 * 把前端传来的 parentId 解析为真实写入的目标容器列表。
 * - null            → 当前用户自己桶的根(admin 也落自己名下,不污染共享空间)
 * - '__shared_root' → 共享空间桶根(仅 admin 视角存在)
 * - 普通目录 id     → [该目录节点, 其 children];他人只读目录/节点抛 403
 */
/**
 * 把前端传来的 parentId 解析为真实写入的目标容器列表(仅新建/拖拽用,需可写)。
 * - '__my_root' 或 null → 当前用户自己桶的根
 * - '__shared_root'    → 共享桶根(仅 admin 可写,否则 403)
 * - 普通目录 id        → [该目录节点, 其 children];落在只读范围(非 admin 的共享桶)抛 403
 */
function resolveTarget(view, parentId) {
  if (!parentId || parentId === MY_ROOT_ID) {
    return [null, view.tree.users[view.ownerKey].my]
  }
  if (parentId === SHARED_ROOT_ID) {
    if (!view.canWriteShared) {
      const err = new Error('共享文件夹仅管理员可修改')
      err.status = 403
      throw err
    }
    return [null, view.tree.users[SHARED_KEY].my]
  }
  const found = findNode(view.nodes, parentId)
  if (found && found[0] && found[0].readonly) {
    const err = new Error('共享文件夹内容只读')
    err.status = 403
    throw err
  }
  return found || null
}

/** 按 id 找节点(深度优先),返回 [node, parentList];跳过只读标记不影响查找 */
function findNode(nodes, nid) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.id === nid) return [n, nodes]
    if (n.type === 'dir' && n.children) {
      const found = findNode(n.children, nid)
      if (found) return found
    }
  }
  return null
}

/** 校验节点属于当前用户可见范围:自己桶 + 共享桶(读);写操作由调用方再验 readonly/canWriteShared */
function findOwnedNode(view, nid) {
  // 先查自己桶
  const own = findNode(view.tree.users[view.ownerKey].my, nid)
  if (own) return own
  // 共享桶所有人可读(save/get/move 校验写权限用 canWriteShared)
  const shared = findNode(view.tree.users[SHARED_KEY].my, nid)
  if (shared) return shared
  return null
}

/** 判断节点 id 是否落在共享桶(含共享桶根);用于写操作只读校验 */
function isSharedNode(view, nid) {
  if (nid === SHARED_ROOT_ID) return true
  return !!findNode(view.tree.users[SHARED_KEY].my, nid)
}

/** 判断移动目标容器是否为共享桶根 */
function isSharedTarget(targetParentId) {
  return targetParentId === SHARED_ROOT_ID || targetParentId === '__shared_root'
}

function validateName(name) {  const s = String(name || '').trim()
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) {
    const err = new Error('非法名称')
    err.status = 400
    throw err
  }
  return s
}

function collectFileIds(nodes, out) {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.id)
    else if (n.type === 'dir' && n.children) collectFileIds(n.children, out)
  }
}

/** 判断节点子树内是否包含某 id(用于禁止拖入自身后代) */
function isDescendant(node, targetId) {
  if (!node.children) return false
  for (const c of node.children) {
    if (c.id === targetId) return true
    if (isDescendant(c, targetId)) return true
  }
  return false
}

export function dbScriptsRouter() {
  const router = Router()

  router.get('/tree', (req, res) => {
    const view = resolveView(req)
    res.json({ code: 0, data: { my: view.nodes } })
  })

  router.post('/new', (req, res) => {
    try {
      const { parentId = null, name = '', kind = '' } = req.body || {}
      if (!['dir', 'file'].includes(kind)) {
        return res.status(400).json({ code: 400, msg: 'kind must be dir|file' })
      }
      const clean = validateName(name)
      const view = resolveView(req)
      // 目标容器:根级/伪根直接给桶根;普通 id 给 [父目录, children]
      let parent = null
      let list
      if (!parentId || parentId === MY_ROOT_ID || parentId === SHARED_ROOT_ID) {
        ;[, list] = resolveTarget(view, parentId) // resolveTarget 内部已做共享桶写权限校验
      } else {
        const found = resolveTarget(view, parentId)
        if (!found) {
          return res.status(404).json({ code: 404, msg: '父目录不存在' })
        }
        ;[parent, list] = found
        if (parent.type !== 'dir') {
          return res.status(400).json({ code: 400, msg: '父级必须是目录' })
        }
      }
      const node = { id: randomUUID().slice(0, 12), name: clean, type: kind }
      if (kind === 'dir') node.children = []
      if (parent) parent.children = parent.children || []
      ;(parent ? parent.children : list).push(node)
      saveTree(view.tree)
      res.json({ code: 0, data: node })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  router.post('/rename', (req, res) => {
    try {
      const { id = '', name = '' } = req.body || {}
      let clean = validateName(name)
      const view = resolveView(req)
      const found = findOwnedNode(view, id)
      if (!found) return res.status(404).json({ code: 404, msg: '节点不存在' })
      if (isSharedNode(view, id) && !view.canWriteShared) {
        return res.status(403).json({ code: 403, msg: '共享文件夹仅管理员可修改' })
      }
      if (found[0].type === 'file' && !clean.endsWith('.sql')) clean += '.sql'
      found[0].name = clean
      saveTree(view.tree)
      res.json({ code: 0, data: found[0] })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  router.post('/delete', (req, res) => {
    try {
      const { id = '' } = req.body || {}
      const view = resolveView(req)
      const found = findOwnedNode(view, id)
      if (!found) return res.status(404).json({ code: 404, msg: '节点不存在' })
      if (isSharedNode(view, id) && !view.canWriteShared) {
        return res.status(403).json({ code: 403, msg: '共享文件夹仅管理员可修改' })
      }
      const [node, parent] = found
      const fileIds = []
      collectFileIds([node], fileIds)
      parent.splice(parent.indexOf(node), 1)
      for (const fid of fileIds) {
        const fp = path.join(FILES_DIR, `${fid}.sql`)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
      }
      saveTree(view.tree)
      res.json({ code: 0, msg: 'deleted' })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  router.post('/move', (req, res) => {
    try {
      const { id = '', targetParentId = null } = req.body || {}
      const view = resolveView(req)
      const found = findOwnedNode(view, id)
      if (!found) return res.status(404).json({ code: 404, msg: '节点不存在' })
      // 被移动节点与目标容器都在只读范围时拒绝(admin 可整理共享桶,普通用户只能移出自己桶的节点)
      if ((isSharedNode(view, id) || isSharedTarget(targetParentId)) && !view.canWriteShared) {
        return res.status(403).json({ code: 403, msg: '共享文件夹仅管理员可修改' })
      }
      const [node, parentList] = found

      let target = null
      let targetChildren = null
      if (targetParentId) {
        if (targetParentId === SHARED_ROOT_ID || targetParentId === '__shared_root') {
          if (!view.canWriteShared) return res.status(403).json({ code: 403, msg: '共享文件夹仅管理员可修改' })
          targetChildren = view.tree.users[SHARED_KEY].my
        } else {
          const tf = findOwnedNode(view, targetParentId)
          if (!tf || tf[0].type !== 'dir') {
            return res.status(400).json({ code: 400, msg: '目标必须是目录' })
          }
          target = tf[0]
          targetChildren = target.children || []
          // 禁止移动到自身或自己的后代目录
          if (node.id === target.id || isDescendant(node, target.id)) {
            return res.status(400).json({ code: 400, msg: '不能移动到自身或其子目录' })
          }
        }
      } else {
        targetChildren = view.tree.users[view.ownerKey].my
      }
      // 已在该目录下则视为无变化
      if (targetChildren === parentList) {
        return res.json({ code: 0, data: node })
      }
      parentList.splice(parentList.indexOf(node), 1)
      if (target) {
        target.children = target.children || []
        target.children.push(node)
      } else {
        targetChildren.push(node)
      }
      saveTree(view.tree)
      res.json({ code: 0, data: node })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  router.post('/save', (req, res) => {
    try {
      const { id = '', content = '' } = req.body || {}
      const view = resolveView(req)
      const found = findOwnedNode(view, id)
      if (!found || found[0].type !== 'file') {
        return res.status(404).json({ code: 404, msg: '文件不存在' })
      }
      if (isSharedNode(view, id) && !view.canWriteShared) {
        return res.status(403).json({ code: 403, msg: '共享文件夹仅管理员可修改' })
      }
      ensureScripts()
      fs.writeFileSync(path.join(FILES_DIR, `${id}.sql`), content, 'utf-8')
      res.json({ code: 0, msg: 'saved' })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  router.get('/get', (req, res) => {
    try {
      const { id = '' } = req.query || {}
      const view = resolveView(req)
      const found = findOwnedNode(view, id)
      if (!found || found[0].type !== 'file') {
        return res.status(404).json({ code: 404, msg: '文件不存在' })
      }
      const fp = path.join(FILES_DIR, `${id}.sql`)
      const content = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : ''
      res.json({ code: 0, data: { id, content } })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  return router
}
