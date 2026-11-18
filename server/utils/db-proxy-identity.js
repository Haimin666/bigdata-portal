import { createHmac } from 'node:crypto'
import config from '../config.js'
import { jobSubjectOf } from './job-ownership.js'

const SUBJECT_TTL_SECONDS = 30

/** Sign the authenticated gateway principal for trusted db-proxy requests. */
export function dbProxyIdentityHeaders(req) {
  const secret = String(config.dbProxyIdentitySecret || config.dbProxyToken || '')
  if (!secret) return {}

  const expiresAt = Math.floor(Date.now() / 1000) + SUBJECT_TTL_SECONDS
  const user = req?.user || {}
  const roles = Array.isArray(user.roles) ? user.roles : []
  const isAdmin = user.role === 'admin' || roles.includes('admin')
  const payload = Buffer.from(JSON.stringify({ subject: jobSubjectOf(req), expiresAt, isAdmin })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  return {
    'X-DB-Subject': payload,
    'X-DB-Subject-Signature': signature
  }
}
