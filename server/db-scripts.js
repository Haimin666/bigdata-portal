// 脚本存储(数据库查询「我的目录」):SQL 脚本目录树 + 文件内容
// 存平台项目内 data/scripts/(docker 挂载 ./data:/app/data,持久化)
// 接口:/api/scripts/tree|new|rename|delete|save|get(由 index.js 挂载)
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const SCRIPTS_DIR =
  process.env.DB_SCRIPTS_DIR || path.join(import.meta.dirname, '../data/scripts')
const TREE_FILE = path.join(SCRIPTS_DIR, 'tree.json')
const FILES_DIR = path.join(SCRIPTS_DIR, 'files')

function ensureScripts() {
  fs.mkdirSync(FILES_DIR, { recursive: true })
  if (!fs.existsSync(TREE_FILE)) {
    fs.writeFileSync(TREE_FILE, JSON.stringify({ my: [] }, null, 2), 'utf-8')
  }
}

function loadTree() {
  ensureScripts()
  try {
    return JSON.parse(fs.readFileSync(TREE_FILE, 'utf-8'))
  } catch {
    return { my: [] }
  }
}

function saveTree(tree) {
  ensureScripts()
  fs.writeFileSync(TREE_FILE, JSON.stringify(tree, null, 2), 'utf-8')
}

/** 按 id 找节点(深度优先),返回 [node, parentList] */
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

function validateName(name) {
  const s = String(name || '').trim()
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

export function dbScriptsRouter() {
  const router = Router()

  router.get('/tree', (req, res) => {
    res.json({ code: 0, data: loadTree() })
  })

  router.post('/new', (req, res) => {
    try {
      const { parentId = null, name = '', kind = '' } = req.body || {}
      if (!['dir', 'file'].includes(kind)) {
        return res.status(400).json({ code: 400, msg: 'kind must be dir|file' })
      }
      const clean = validateName(name)
      const tree = loadTree()
      let parent = null
      if (parentId) {
        const found = findNode(tree.my, parentId)
        if (!found || found[0].type !== 'dir') {
          return res.status(404).json({ code: 404, msg: '父目录不存在' })
        }
        parent = found[0]
      }
      const node = { id: randomUUID().slice(0, 12), name: clean, type: kind }
      if (kind === 'dir') node.children = []
      if (parent) parent.children = parent.children || []
      ;(parent ? parent.children : tree.my).push(node)
      saveTree(tree)
      res.json({ code: 0, data: node })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  router.post('/rename', (req, res) => {
    try {
      const { id = '', name = '' } = req.body || {}
      let clean = validateName(name)
      const tree = loadTree()
      const found = findNode(tree.my, id)
      if (!found) return res.status(404).json({ code: 404, msg: '节点不存在' })
      if (found[0].type === 'file' && !clean.endsWith('.sql')) clean += '.sql'
      found[0].name = clean
      saveTree(tree)
      res.json({ code: 0, data: found[0] })
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  router.post('/delete', (req, res) => {
    try {
      const { id = '' } = req.body || {}
      const tree = loadTree()
      const found = findNode(tree.my, id)
      if (!found) return res.status(404).json({ code: 404, msg: '节点不存在' })
      const [node, parent] = found
      const fileIds = []
      collectFileIds([node], fileIds)
      parent.splice(parent.indexOf(node), 1)
      for (const fid of fileIds) {
        const fp = path.join(FILES_DIR, `${fid}.sql`)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
      }
      saveTree(tree)
      res.json({ code: 0, msg: 'deleted' })
    } catch (e) {
      res.status(500).json({ code: 500, msg: e.message })
    }
  })

  router.post('/save', (req, res) => {
    try {
      const { id = '', content = '' } = req.body || {}
      const tree = loadTree()
      const found = findNode(tree.my, id)
      if (!found || found[0].type !== 'file') {
        return res.status(404).json({ code: 404, msg: '文件不存在' })
      }
      ensureScripts()
      fs.writeFileSync(path.join(FILES_DIR, `${id}.sql`), content, 'utf-8')
      res.json({ code: 0, msg: 'saved' })
    } catch (e) {
      res.status(500).json({ code: 500, msg: e.message })
    }
  })

  router.get('/get', (req, res) => {
    try {
      const { id = '' } = req.query || {}
      const tree = loadTree()
      const found = findNode(tree.my, id)
      if (!found || found[0].type !== 'file') {
        return res.status(404).json({ code: 404, msg: '文件不存在' })
      }
      const fp = path.join(FILES_DIR, `${id}.sql`)
      const content = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : ''
      res.json({ code: 0, data: { id, content } })
    } catch (e) {
      res.status(500).json({ code: 500, msg: e.message })
    }
  })

  return router
}
