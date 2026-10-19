import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DB_QUERY_API_ROLE,
  dbQueryApiRouteScope,
  isDbQueryApiReadSql,
  sparkWriteTargetDatabase,
  isSparkApiSqlShapeAllowed,
  createDbQueryApiJobRegistry
} from '../utils/db-query-api-policy.js'
import {
  apiTokenAllowsDatabase,
  apiTokenAllowsImpalaDatabase,
  apiTokenRoleRule,
  checkDbRuleAccess,
  checkSparkRuleAccess
} from '../db-permissions.js'

test('route policy grants relational SQL query and owned job surfaces only', () => {
  assert.equal(dbQueryApiRouteScope('POST', '/api/db/jobs'), 'database-job-submit')
  assert.equal(dbQueryApiRouteScope('GET', '/api/db/jobs/job-1'), 'database-job')
  assert.equal(dbQueryApiRouteScope('POST', '/api/db/jobs/job-1/cancel'), 'database-job')
  assert.equal(dbQueryApiRouteScope('GET', '/api/db/schema'), 'impala')
  assert.equal(dbQueryApiRouteScope('POST', '/api/spark/query'), 'spark')
  assert.equal(dbQueryApiRouteScope('GET', '/api/spark/schema/databases'), 'spark')
  assert.equal(dbQueryApiRouteScope('POST', '/api/dbquery/query'), 'relational-query')
  assert.equal(dbQueryApiRouteScope('POST', '/api/db/explain'), 'impala')
  assert.equal(dbQueryApiRouteScope('POST', '/api/flink/query'), null)
  assert.equal(dbQueryApiRouteScope('PUT', '/api/db/jobs'), null)
  assert.equal(dbQueryApiRouteScope('GET', '/api/db-perms'), null)
})

test('read-only token accepts read statements and fails closed on writes or session changes', () => {
  assert.equal(isDbQueryApiReadSql('select * from sales.orders'), true)
  assert.equal(isDbQueryApiReadSql('WITH t AS (SELECT 1) SELECT * FROM t'), true)
  assert.equal(isDbQueryApiReadSql('show tables'), true)
  assert.equal(isDbQueryApiReadSql('use sales'), false)
  assert.equal(isDbQueryApiReadSql('set spark.sql.shuffle.partitions=2'), false)
  assert.equal(isDbQueryApiReadSql('delete from sales.orders'), false)
  assert.equal(isDbQueryApiReadSql('WITH t AS (SELECT 1) DELETE FROM sales.orders'), false)
  assert.equal(isDbQueryApiReadSql('SELECT * FROM sales.orders FOR UPDATE'), false)
  assert.equal(isDbQueryApiReadSql('select 1; drop table sales.orders'), false)
})

test('Spark write token requires a qualified INSERT target and matching configured database', () => {
  const sql = 'INSERT OVERWRITE TABLE `spark_stage`.`daily` SELECT * FROM source'
  assert.equal(sparkWriteTargetDatabase(sql), 'spark_stage')
  assert.equal(isSparkApiSqlShapeAllowed(sql, 'spark_stage'), true)
  assert.equal(isSparkApiSqlShapeAllowed(sql, 'other_db'), false)
  assert.equal(isSparkApiSqlShapeAllowed('INSERT INTO daily SELECT 1', 'spark_stage'), false)
  assert.equal(isSparkApiSqlShapeAllowed('CREATE TABLE spark_stage.daily AS SELECT 1', 'spark_stage'), false)
  assert.equal(isSparkApiSqlShapeAllowed('INSERT INTO spark_stage.daily SELECT 1; SELECT 2', 'spark_stage'), false)
})

test('async job access is limited to registered engine jobs and expires', () => {
  let now = 1000
  const registry = createDbQueryApiJobRegistry({ ttlMs: 50, now: () => now })
  registry.register('impala', 'impala-job-1', 'impala_ro')

  assert.equal(registry.has('impala', 'impala-job-1'), true)
  assert.equal(registry.has('spark', 'impala-job-1'), false)
  now += 51
  assert.equal(registry.has('impala', 'impala-job-1'), false)
})

test('API principal database permissions allow only configured read-only engines and fail closed', () => {
  const perms = { roleRules: [{ role: DB_QUERY_API_ROLE, engineRules: [
    { engine: 'impala', db: 'impala_ro', read: true, write: false, tables: null },
    { engine: 'mysql', db: 'mysql_ro', read: true, write: false, tables: null },
    { engine: 'oracle', db: 'oracle_ro', read: true, write: false, tables: null }
  ] }] }
  const rule = apiTokenRoleRule(perms)
  assert.ok(rule)
  assert.doesNotThrow(() => checkDbRuleAccess(rule, 'impala_ro', { engine: 'impala' }))
  assert.doesNotThrow(() => checkDbRuleAccess(rule, 'mysql_ro', { engine: 'mysql' }))
  assert.doesNotThrow(() => checkDbRuleAccess(rule, 'oracle_ro', { engine: 'oracle' }))
  assert.throws(() => checkDbRuleAccess(rule, 'other_db', { engine: 'impala' }), { statusCode: 403 })
  assert.throws(() => checkDbRuleAccess(rule, 'mysql_ro', { engine: 'mysql', write: true }), { statusCode: 403 })
  assert.throws(() => checkDbRuleAccess(rule, 'oracle_ro', { engine: 'doris' }), { statusCode: 403 })
  assert.throws(() => checkDbRuleAccess({ engineRules: [
    { engine: 'impala', db: 'impala_ro', read: true, write: false, tables: ['allowed_table'] }
  ] }, 'impala_ro', { engine: 'impala', requireWholeDatabase: true }), { statusCode: 403 })
  const missingRule = apiTokenRoleRule({ roleRules: [] })
  assert.equal(missingRule, null)
  assert.throws(() => checkDbRuleAccess(missingRule, 'impala_ro', { engine: 'impala' }), { statusCode: 403 })
  assert.equal(apiTokenAllowsImpalaDatabase({ roleRules: [] }, 'impala_ro'), false)
  assert.equal(apiTokenAllowsImpalaDatabase(perms, 'impala_ro'), true)
  assert.equal(apiTokenAllowsImpalaDatabase(perms, 'other_db'), false)
  assert.equal(apiTokenAllowsDatabase(perms, 'mysql', 'mysql_ro'), true)
  assert.equal(apiTokenAllowsDatabase(perms, 'oracle', 'oracle_ro'), true)
  assert.equal(apiTokenAllowsDatabase(perms, 'doris', 'mysql_ro'), false)
})

test('API principal can read Spark but write only to configured database', () => {
  const rule = { spark: { read: true, write: true, writeDbs: ['spark_stage'] } }
  assert.doesNotThrow(() => checkSparkRuleAccess(rule, false))
  assert.doesNotThrow(() => checkSparkRuleAccess(rule, true, 'spark_stage', { requireWriteDbList: true }))
  assert.throws(() => checkSparkRuleAccess(rule, true, 'other_db', { requireWriteDbList: true }), { statusCode: 403 })
  assert.throws(() => checkSparkRuleAccess(rule, true, '', { requireWriteDbList: true }), { statusCode: 403 })
  assert.throws(() => checkSparkRuleAccess({ spark: { read: true, write: true, writeDbs: ['*'] } }, true, 'any_db', { requireWriteDbList: true }), { statusCode: 403 })
  assert.throws(() => checkSparkRuleAccess(null, false, '', { requireWriteDbList: true }), { statusCode: 403 })
  assert.doesNotThrow(() => checkSparkRuleAccess({ spark: { read: true, write: true } }, true, 'legacy_db'))
})
