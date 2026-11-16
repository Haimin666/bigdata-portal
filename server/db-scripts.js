// 脚本存储(数据库查询「我的目录」):SQL 脚本目录树 + 文件内容
// 存平台项目内 data/scripts/(docker 挂载 ./data:/app/data,持久化)
// 接口:/api/scripts/tree|new|rename|delete|save|get(由 index.js 挂载)
//
// 用户隔离(2026-08):目录树按用户名分桶存储,tree.json 结构
//   { "users": { "<username>": { "my": [...] }, "__shared__": { "my": [...] } } }
// - 每个用户看到两个固定根:「我的文件夹」(私有桶,仅本人可见可写)
//   和「共享文件夹」(公共桶 __shared__,所有人可读可写,全员协作)。
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

/** tree.json 损坏时抛错(不得用空树覆盖):否则一次读取失败就会把所有人的目录清空。 */
function corruptedTreeError(reason) {
  const err = new Error(`脚本目录数据损坏(tree.json 无法解析),已拒绝写入以免覆盖: ${reason}`)
  err.status = 500
  return err
}

/** 读原始 tree.json,自动迁移旧格式({my:[]} → 按用户分桶)。 */
function loadRawTree() {
  ensureScripts()
  if (!fs.existsSync(TREE_FILE)) return { users: {} }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(TREE_FILE, 'utf-8'))
  } catch (e) {
    throw corruptedTreeError(e instanceof Error ? e.message : String(e))
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw corruptedTreeError('顶层不是对象')
  if (raw.users != null && (typeof raw.users !== 'object' || Array.isArray(raw.users))) {
    throw corruptedTreeError('users 字段不是对象')
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

/** 原子写:.tmp + renameSync,避免进程中断留下半截 JSON(下次解析失败会触发只读保护)。 */
function saveTree(tree) {
  ensureScripts()
  const tmp = `${TREE_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(tree, null, 2), 'utf-8')
    fs.renameSync(tmp, TREE_FILE)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 忽略清理失败 */
    }
    throw e
  }
}

/**
 * 解析当前请求可见的树视图。
 * 返回 { tree, ownerKey, nodes }:nodes 固定为双根——
 * 「我的文件夹」(用户自己桶)+「共享文件夹」(__shared__ 公共桶)。
 * 共享桶按产品语义「所有人可读可写」(2026-08),因此不再有 canWriteShared
 * 之类的只读校验(历史上恒为 true 的死代码已删除)。
 */
function resolveView(req) {
  const user = req.user || {}
  const username = String(user.username || 'anonymous')
  const tree = loadRawTree()

  if (!tree.users[username]) tree.users[username] = { my: [] }
  if (!tree.users[SHARED_KEY]) tree.users[SHARED_KEY] = { my: [] }

  const nodes = [
    { id: MY_ROOT_ID, name: '我的文件夹', type: 'dir', children: tree.users[username].my },
    {
      id: SHARED_ROOT_ID,
      name: '共享文件夹',
      type: 'dir',
      readonly: false, // 全员可编辑
      children: tree.users[SHARED_KEY].my
    }
  ]
  return { tree, ownerKey: username, nodes }
}

/**
 * 把前端传来的 parentId 解析为真实写入的目标容器列表(新建/拖拽用)。
 * - '__my_root' 或 null → 当前用户自己桶的根
 * - '__shared_root'    → 共享桶根(共享文件夹所有人可读可写)
 * - 普通目录 id        → [该目录节点, 其 children]
 */
function resolveTarget(view, parentId) {
  if (!parentId || parentId === MY_ROOT_ID) {
    return [null, view.tree.users[view.ownerKey].my]
  }
  if (parentId === SHARED_ROOT_ID) {
    return [null, view.tree.users[SHARED_KEY].my]
  }
  const found = findNode(view.nodes, parentId)
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

/** 校验节点属于当前用户可见范围:自己桶 + 共享桶(两者均可写,共享桶为全员协作空间) */
function findOwnedNode(view, nid) {
  // 先查自己桶
  const own = findNode(view.tree.users[view.ownerKey].my, nid)
  if (own) return own
  // 共享桶所有人可读可写(全员协作空间)
  const shared = findNode(view.tree.users[SHARED_KEY].my, nid)
  if (shared) return shared
  return null
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
    try {
      const view = resolveView(req)
      res.json({ code: 0, data: { my: view.nodes } })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
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
        ;[, list] = resolveTarget(view, parentId)
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
      const [node, parentList] = found

      let target = null
      let targetChildren = null
      if (targetParentId) {
        if (targetParentId === SHARED_ROOT_ID || targetParentId === '__shared_root') {
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
      ensureScripts()
      // 原子写:.tmp + rename,避免半截 SQL 覆盖原文件
      const fp = path.join(FILES_DIR, `${id}.sql`)
      const tmp = `${fp}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      try {
        fs.writeFileSync(tmp, content, 'utf-8')
        fs.renameSync(tmp, fp)
      } catch (e) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* 忽略清理失败 */
        }
        throw e
      }
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
