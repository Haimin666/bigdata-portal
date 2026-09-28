import { isSparkWriteSql, splitSqlStatements } from './sql-write-detect.js'

const JOB_TTL_MS = 2 * 60 * 60 * 1000
const JOB_MAX_SIZE = 5000
export const DB_QUERY_API_ROLE = 'db-query-api'

/** Route-level allowlist for the external database API identity. */
export function dbQueryApiRouteScope(method, pathname) {
  const verb = String(method || '').toUpperCase()
  const path = String(pathname || '').toLowerCase().replace(/\/$/, '') || '/'
  if (verb === 'GET' && path === '/api/db/acl') return 'impala'
  if (verb === 'GET' && /^\/api\/db\/(tables|fields|ddl|schema)$/.test(path)) return 'impala'
  if (verb === 'POST' && ['/api/db/jobs', '/api/db/explain'].includes(path)) return 'impala'
  if (verb === 'GET' && /^\/api\/db\/jobs\/[a-z0-9_-]+$/.test(path)) return 'impala-job'
  if (verb === 'POST' && /^\/api\/db\/jobs\/[a-z0-9_-]+\/cancel$/.test(path)) return 'impala-job'

  if (verb === 'GET' && /^\/api\/spark\/schema\/(databases|tables|fields)$/.test(path)) return 'spark'
  if (verb === 'POST' && ['/api/spark/query', '/api/spark/jobs'].includes(path)) return 'spark'
  if (verb === 'GET' && /^\/api\/spark\/jobs\/[a-z0-9_-]+$/.test(path)) return 'spark-job'
  if (verb === 'POST' && /^\/api\/spark\/jobs\/[a-z0-9_-]+\/cancel$/.test(path)) return 'spark-job'
  return null
}

function oneStatement(sql) {
  const statements = splitSqlStatements(String(sql || '')).map((item) => item.trim()).filter(Boolean)
  return statements.length === 1 ? statements[0] : ''
}

function withoutLeadingComments(sql) {
  let value = String(sql || '').trim()
  while (value) {
    if (value.startsWith('--')) {
      const newline = value.indexOf('\n')
      value = newline < 0 ? '' : value.slice(newline + 1).trimStart()
      continue
    }
    if (value.startsWith('/*')) {
      if (/^\/\*[Mm]?!/.test(value)) return ''
      const end = value.indexOf('*/', 2)
      if (end < 0) return ''
      value = value.slice(end + 2).trimStart()
      continue
    }
    break
  }
  return value
}

/** Strict read-only SQL policy for API-token calls (not for the interactive UI). */
export function isDbQueryApiReadSql(sql) {
  const statement = oneStatement(sql)
  if (!statement || isSparkWriteSql(statement)) return false
  const normalized = withoutLeadingComments(statement)
  return /^(SELECT|WITH|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i.test(normalized)
}

const SQL_IDENTIFIER = '(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)'
const INSERT_TARGET = new RegExp(`^INSERT\\s+(?:INTO|OVERWRITE)\\s+(?:TABLE\\s+)?(${SQL_IDENTIFIER})\\s*\\.\\s*(${SQL_IDENTIFIER})(?:\\s|$)`, 'i')

function unquoteIdentifier(identifier) {
  return identifier.startsWith('`') ? identifier.slice(1, -1).replace(/``/g, '`') : identifier
}

/** Only accept Spark INSERT targets explicitly qualified as database.table. */
export function sparkWriteTargetDatabase(sql) {
  const statement = oneStatement(sql)
  if (!statement || !isSparkWriteSql(statement)) return null
  const normalized = withoutLeadingComments(statement)
  const match = INSERT_TARGET.exec(normalized)
  return match ? unquoteIdentifier(match[1]) : null
}

export function isSparkApiSqlShapeAllowed(sql, requestedDatabase) {
  if (isDbQueryApiReadSql(sql)) return true
  const targetDatabase = sparkWriteTargetDatabase(sql)
  const requested = String(requestedDatabase || '').trim()
  if (!targetDatabase || !requested) return false
  return targetDatabase.toLowerCase() === requested.toLowerCase()
}

/** In-memory ownership for API-submitted async jobs; never exposes unrelated UI jobs. */
export function createDbQueryApiJobRegistry({ ttlMs = JOB_TTL_MS, maxSize = JOB_MAX_SIZE, now = Date.now } = {}) {
  const jobs = new Map()

  function prune() {
    const timestamp = now()
    for (const [id, record] of jobs) {
      if (record.expiresAt <= timestamp) jobs.delete(id)
    }
    while (jobs.size > maxSize) jobs.delete(jobs.keys().next().value)
  }

  return {
    register(engine, jobId, database = '') {
      if (!jobId) return
      prune()
      const id = String(jobId)
      jobs.delete(id)
      jobs.set(id, { engine: String(engine), database: String(database), expiresAt: now() + ttlMs })
      prune()
    },
    has(engine, jobId) {
      prune()
      const record = jobs.get(String(jobId))
      return !!record && record.engine === String(engine)
    },
    database(engine, jobId) {
      prune()
      const record = jobs.get(String(jobId))
      return record?.engine === String(engine) ? record.database : ''
    }
  }
}
