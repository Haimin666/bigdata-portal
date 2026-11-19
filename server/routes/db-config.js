// Admin-only datasource management proxy. The browser never receives the db-proxy management token.
import express from 'express'
import config from '../config.js'
import { loadPerms } from '../db-permissions.js'
import { refreshEngineMap } from '../engine-map.js'

const router = express.Router()

function adminOnly(auth) {
  return (req, res, next) => {
    if (!auth?.enabled) {
      return res.status(503).json({ code: 503, msg: '启用门户认证后才能管理数据库连接' })
    }
    return auth.requireAdmin(req, res, next)
  }
}

function rejectCrossSite(req, res, next) {
  if (String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
    return res.status(403).json({ code: 403, msg: '跨站请求已拒绝' })
  }
  if (['POST', 'PUT'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ code: 415, msg: '请求必须使用 application/json' })
  }
  return next()
}

function datasourceName(req, res, next) {
  const name = String(req.params.name || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    return res.status(400).json({ code: 400, msg: '数据源名称无效' })
  }
  req.datasourceName = name
  return next()
}

function isReferencedByPermission(name) {
  const perms = loadPerms()
  if (perms?.broken) throw new Error('permission rules are unreadable')
  for (const rule of [...(perms.userRules || []), ...(perms.roleRules || [])]) {
    if ((rule?.engineRules || []).some((entry) => String(entry?.db || '') === name)) return true
  }
  return false
}

async function refreshEngineMapFromProxy() {
  try {
    if (!config.dbProxyUrl) return
    const response = await fetch(config.dbProxyUrl + '/acl', {
      headers: { 'X-DB-Token': config.dbProxyToken || '' },
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) return
    const body = await response.json().catch(() => ({}))
    if (Array.isArray(body?.data?.datasources)) refreshEngineMap(body.data.datasources)
  } catch {
    // The regular ACL path retries and reports upstream failures; do not fail a saved change here.
  }
}

async function proxyAdmin(req, res, method, endpoint, body, { refresh = false } = {}) {
  if (!config.dbProxyUrl) {
    return res.status(503).json({ code: 503, msg: 'db-proxy 未配置' })
  }
  if (!config.dbProxyAdminToken) {
    return res.status(503).json({ code: 503, msg: '服务端未配置 dbProxyAdminToken' })
  }
  const headers = { 'X-DB-Admin-Token': config.dbProxyAdminToken }
  if (method === 'DELETE' && req.get('if-match')) headers['If-Match'] = req.get('if-match')
  const options = { method, headers, signal: AbortSignal.timeout(12000) }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  try {
    const upstream = await fetch(config.dbProxyUrl + endpoint, options)
    const result = await upstream.json().catch(() => ({}))
    if (!upstream.ok) {
      const message = typeof result?.detail === 'string' ? result.detail : 'db-proxy 管理请求失败'
      return res.status(upstream.status).json({ code: upstream.status, msg: message })
    }
    if (refresh) {
      const datasources = result?.data?.datasources
      if (Array.isArray(datasources)) refreshEngineMap(datasources)
      else await refreshEngineMapFromProxy()
    }
    return res.json(result)
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return res.status(timeout ? 504 : 502).json({ code: timeout ? 504 : 502, msg: timeout ? 'db-proxy 管理请求超时' : '无法连接 db-proxy 管理接口' })
  }
}

export function setupDbConfig(app, auth) {
  router.use(adminOnly(auth), rejectCrossSite)

  router.get('/datasources', (req, res) =>
    proxyAdmin(req, res, 'GET', '/admin/datasources'))

  router.post('/datasources', (req, res) =>
    proxyAdmin(req, res, 'POST', '/admin/datasources', req.body, { refresh: true }))

  router.post('/test', (req, res) =>
    proxyAdmin(req, res, 'POST', '/admin/datasources/test', req.body))

  router.post('/discover-owners', (req, res) =>
    proxyAdmin(req, res, 'POST', '/admin/datasources/discover-owners', req.body))

  router.put('/datasources/:name', datasourceName, (req, res) =>
    proxyAdmin(req, res, 'PUT', `/admin/datasources/${encodeURIComponent(req.datasourceName)}`, req.body, { refresh: true }))

  router.delete('/datasources/:name', datasourceName, async (req, res) => {
    try {
      if (isReferencedByPermission(req.datasourceName)) {
        return res.status(409).json({ code: 409, msg: '该数据源仍被用户或角色的数据权限规则引用，不能删除' })
      }
    } catch {
      return res.status(503).json({ code: 503, msg: '无法确认数据权限规则，暂不能删除该数据源' })
    }
    return proxyAdmin(req, res, 'DELETE', `/admin/datasources/${encodeURIComponent(req.datasourceName)}`, undefined, { refresh: true })
  })

  app.use('/api/db-config', router)
}
