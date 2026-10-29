import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import config from '../config.js'

// Only replace the external db-proxy transport and permission file; execute real
// routes, SQL policy, permission checks and gateway serialization together.
config.dbProxyUrl = 'http://spark-proxy.invalid'
config.dbProxyToken = 'test-db-proxy-token'
const { setupSpark } = await import('../routes/spark.js')
const routes = new Map()
setupSpark({
  get(path, handler) { routes.set(`GET ${path}`, handler) },
  post(path, handler) { routes.set(`POST ${path}`, handler) }
})
const originalFetch = globalThis.fetch
const originalRead = fs.readFileSync
let calls = []
let failure = null
fs.readFileSync = function (path, ...args) {
  if (String(path).endsWith('/data/db-permissions.json')) {
    return JSON.stringify({ userRules: [], roleRules: [
      { role: 'reader', spark: { read: true, write: false } },
      { role: 'db-query-api', spark: { read: true, write: true, writeDbs: ['allowed'] } }
    ] })
  }
  return originalRead.call(this, path, ...args)
}
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: new URL(url, 'http://portal.invalid'), options, body: options.body ? JSON.parse(options.body) : undefined })
  return { ok: !failure, status: failure ? 503 : 200, json: async () => failure ? { detail: failure } : { code: 0, data: { jobId: 'job-1', marker: 'original-result' } } }
}
after(() => { globalThis.fetch = originalFetch; fs.readFileSync = originalRead })
beforeEach(() => { calls = []; failure = null })
async function invoke(method, path, { body = {}, query = {}, user = { role: 'admin' }, ...extra } = {}) {
  const handler = routes.get(`${method} ${path}`)
  assert.equal(typeof handler, 'function', `registered ${method} ${path}`)
  const req = { body, query, user, params: { jobId: 'job-1' }, ...extra }
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(value) { this.body = value; return this } }
  await handler(req, res)
  return res
}

test('query and SQL/export submissions default to Thrift and forward explicit Session JSON', async () => {
  for (const path of ['/api/spark/query', '/api/spark/jobs', '/api/spark/export/jobs']) {
    for (const executionMode of [undefined, 'session']) {
      const res = await invoke('POST', path, { body: { sql: 'SELECT 1', executionMode, timeoutMs: 20000 } })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.body, { code: 0, data: { jobId: 'job-1', marker: 'original-result' } })
      const call = calls.at(-1)
      assert.equal(call.body.executionMode, executionMode ?? 'thrift')
      assert.equal(call.body.timeoutMs, 20000)
      assert.equal(call.options.headers['X-DB-Token'], 'test-db-proxy-token')
    }
  }
})

test('all metadata, diagnostics, stages and job polling forward GET query mode and log offsets', async () => {
  for (const path of ['/api/spark/schema/databases', '/api/spark/schema/tables', '/api/spark/schema/fields', '/api/spark/logs', '/api/spark/status', '/api/spark/stages', '/api/spark/jobs/:jobId']) {
    for (const executionMode of [undefined, 'session']) {
      const res = await invoke('GET', path, { query: { executionMode, db: 'a b', table: 't&x', jvm: '42', audit: '84' } })
      assert.equal(res.statusCode, 200)
      const url = calls.at(-1).url
      assert.equal(url.searchParams.get('executionMode'), executionMode ?? 'thrift')
      if (path.endsWith('/logs')) {
        assert.equal(url.searchParams.get('jvm'), '42')
        assert.equal(url.searchParams.get('audit'), '84')
      }
      if (path.endsWith('/fields')) {
        assert.equal(url.searchParams.get('db'), 'a b')
        assert.equal(url.searchParams.get('table'), 't&x')
      }
    }
  }
})

test('direct and job cancellation use JSON mode, including bodyless default', async () => {
  for (const path of ['/api/spark/cancel', '/api/spark/jobs/:jobId/cancel']) {
    for (const executionMode of [undefined, 'session']) {
      assert.equal((await invoke('POST', path, { body: { executionMode } })).statusCode, 200)
      assert.deepEqual(calls.at(-1).body, { executionMode: executionMode ?? 'thrift' })
    }
  }
})

test('Session never bypasses reader write checks or token SQL/export checks', async () => {
  for (const path of ['/api/spark/query', '/api/spark/jobs']) {
    const res = await invoke('POST', path, { body: { sql: 'INSERT INTO allowed.t SELECT 1', db: 'allowed', executionMode: 'session' }, user: { role: 'reader' } })
    assert.equal(res.statusCode, 403)
    assert.equal(calls.length, 0)
    const tokenRes = await invoke('POST', path, { body: { sql: 'DROP TABLE allowed.t', db: 'allowed', executionMode: 'session' }, dbQueryApiPrincipal: { role: 'db-query-api' } })
    assert.equal(tokenRes.statusCode, 403)
    assert.equal(calls.length, 0)
  }
  assert.equal((await invoke('POST', '/api/spark/export/jobs', { body: { sql: 'DELETE FROM allowed.t', executionMode: 'session' } })).statusCode, 400)
  assert.equal(calls.length, 0)
})

test('authorized Session writes retain write header and token job ownership', async () => {
  const principal = { role: 'db-query-api' }
  const res = await invoke('POST', '/api/spark/jobs', { body: { sql: 'INSERT INTO allowed.t SELECT 1', db: 'allowed', executionMode: 'session' }, dbQueryApiPrincipal: principal })
  assert.equal(res.statusCode, 200)
  assert.equal(calls[0].body.writeUnlocked, true)
  assert.equal(calls[0].body.executionMode, 'session')
  assert.equal((await invoke('GET', '/api/spark/jobs/:jobId', { dbQueryApiPrincipal: principal, query: { executionMode: 'thrift' } })).statusCode, 200)
  const count = calls.length
  assert.equal((await invoke('POST', '/api/spark/jobs/:jobId/cancel', { dbQueryApiPrincipal: principal, params: { jobId: 'unowned' }, body: { executionMode: 'session' } })).statusCode, 403)
  assert.equal(calls.length, count)
})

test('Session backend errors preserve diagnostics without another submission', async () => {
  failure = 'original session connection failed'
  const res = await invoke('POST', '/api/spark/query', { body: { sql: 'SELECT 1', executionMode: 'session' } })
  assert.equal(res.statusCode, 502)
  assert.match(res.body.msg, /original session connection failed/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.executionMode, 'session')
})

test('frontend Spark API defaults and explicit mode stay in JSON/GET contracts', async () => {
  const api = await import('../../src/api/db.ts')
  for (const mode of [undefined, 'session']) {
    const expected = mode ?? 'thrift'
    for (const submit of [
      () => api.querySpark('SELECT 1', undefined, 20000, mode),
      () => api.submitSparkJob('SELECT 1', undefined, 20000, mode),
      () => api.submitSparkExportJob('allowed', 'SELECT 1', 20000, mode),
      () => api.cancelSpark(mode),
      () => api.cancelSparkJob('job-1', mode)
    ]) {
      await submit()
      assert.equal(calls.at(-1).body.executionMode, expected)
    }
    for (const read of [
      () => api.getSparkJob('job-1', mode),
      () => api.sparkLogs({ jvm: 42, audit: 84 }, mode),
      () => api.sparkStatus(mode),
      () => api.sparkStages(mode),
      () => api.listSparkDatabases(mode),
      () => api.listSparkTables('db', mode),
      () => api.listSparkFields('db', 't', mode)
    ]) {
      await read()
      assert.equal(calls.at(-1).url.searchParams.get('executionMode'), expected)
    }
  }
})

// Exercise the actual workbench functions with controlled timers/API boundaries;
// no Vue/browser build or live Spark process is needed for job lifetime checks.
async function workbenchFunction(name, context) {
  const { stripTypeScriptTypes } = await import('node:module')
  const { runInNewContext } = await import('node:vm')
  const script = fs.readFileSync(new URL('../../src/views/db/QueryView.vue', import.meta.url), 'utf8')
  const fn = script.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0]
  assert.ok(fn, `${name} function available`)
  runInNewContext(`${stripTypeScriptTypes(fn)}; globalThis.run = ${name}`, context)
  return context.run
}

test('workbench polls and stops with submitted job mode after selection changes', async () => {
  const events = []
  const context = {
    sparkExecutionMode: { value: 'session' }, currentSparkJob: { value: null },
    batchCancelled: false, Date,
    submitSparkJob: async (...args) => {
      events.push(['submit', args[3]])
      context.sparkExecutionMode.value = 'thrift'
      return { jobId: 'session-job' }
    },
    getSparkJob: async (id, mode) => { events.push(['poll', id, mode]); return { state: 'running' } },
    cancelSparkJob: async (id, mode) => { events.push(['cancel', id, mode]) },
    setTimeout: (resolve) => { context.batchCancelled = true; resolve() }
  }
  const exec = await workbenchFunction('execSpark', context)
  await assert.rejects(exec('SELECT 1'), /已取消/)
  assert.deepEqual(events, [['submit', 'session'], ['poll', 'session-job', 'session'], ['cancel', 'session-job', 'session']])
  assert.equal(context.currentSparkJob.value, null)
})

test('stop button uses current job identity and immutable mode', async () => {
  const events = []
  const context = {
    batchCancelled: false, runSeq: 0, currentSparkJob: { value: { jobId: 'session-job', executionMode: 'session' } },
    sparkExecutionMode: { value: 'thrift' }, loading: { value: true },
    cancelSparkJob: async (id, mode) => { events.push([id, mode]) },
    stopSparkLogPolling: () => {}, ElMessage: { info() {}, error(message) { assert.fail(message) } }
  }
  const stop = await workbenchFunction('stopQuery', context)
  await stop()
  assert.deepEqual(events, [['session-job', 'session']])
  assert.equal(context.batchCancelled, true)
})

test('late diagnostics from an old mode cannot populate the new mode', async () => {
  let resolveLogs
  let resolveStages
  const events = []
  const context = {
    sparkLogSeq: 1, sparkExecutionMode: { value: 'session' },
    sparkLogOffsets: { value: { jvm: 42, audit: 84 } }, sparkLogFileSizes: { value: { jvm: 0, audit: 0 } },
    sparkLogText: { value: '' }, sparkStageSnapshot: { value: null }, maxLogLines: { value: 200 },
    sparkLogs: (_offsets, mode) => { events.push(['logs', mode]); return new Promise((resolve) => { resolveLogs = resolve }) },
    sparkStages: (mode) => { events.push(['stages', mode]); return new Promise((resolve) => { resolveStages = resolve }) }
  }
  const poll = await workbenchFunction('pollSparkLogs', context)
  const pending = poll()
  context.sparkLogSeq++
  context.sparkExecutionMode.value = 'thrift'
  resolveLogs({ content: 'old session log', offsets: { jvm: 50, audit: 90 }, files: { jvm: 50, audit: 90 } })
  resolveStages({ stages: [{ stageId: 1 }], numActiveStages: 1 })
  await pending
  assert.deepEqual(events, [['logs', 'session'], ['stages', 'session']])
  assert.equal(context.sparkLogText.value, '')
  assert.equal(context.sparkStageSnapshot.value, null)
})

test('Spark table preview retains Spark engine and skips relational editing metadata', async () => {
  let previewSql = ''
  const context = {
    loading: { value: false }, sparkBatchActive: { value: false }, tabs: { value: [] }, MAX_TABS: 10,
    datasources: { value: [] }, engine: { value: 'mysql' }, db: { value: '' }, SPARK_SOURCE: { name: 'spark' },
    activeTabId: { value: '' }, results: { value: [] },
    flushActiveContent() {}, showTabInEditor() {},
    editorRef: { value: { setValue(sql) { previewSql = sql } } },
    runQuery: async () => {
      assert.equal(context.engine.value, 'sparksql')
      assert.equal(context.db.value, 'spark')
      context.results.value.push({ sql: previewSql, rows: [] })
    },
    loadPreviewPk: () => { assert.fail('Spark preview must not request relational primary keys') },
    ElMessage: { warning(message) { assert.fail(message) } }
  }
  const preview = await workbenchFunction('onOpenTable', context)
  await preview({ db: 'analytics', table: 't`x', engine: 'spark' })
  assert.equal(previewSql, 'SELECT * FROM `analytics`.`t``x` LIMIT 100')
  assert.equal(context.results.value[0].editable, undefined)
})

test('HDFS export cancellation retains submission mode after selection changes', async () => {
  const events = []
  const context = {
    loading: { value: false }, exportLoading: { value: false }, sparkBatchActive: { value: false },
    engine: { value: 'sparksql' }, db: { value: 'spark' }, error: { value: '' },
    sparkExecutionMode: { value: 'session' }, currentSparkJob: { value: null }, batchCancelled: false, Date,
    ensureDb: () => true, getSqlToRun: () => 'SELECT 1', collectRunVars: () => ({}), expandSqlVars: (sql) => sql,
    clearSparkLogs: async () => {}, startSparkLogPolling() {}, pollSparkLogs: async () => {}, stopSparkLogPolling() {},
    submitSparkExportJob: async (_db, _sql, _timeout, mode) => {
      events.push(['submit', mode])
      context.sparkExecutionMode.value = 'thrift'
      return { jobId: 'export-session' }
    },
    getSparkJob: async (id, mode) => { events.push(['poll', id, mode]); return { state: 'running' } },
    cancelSparkJob: async (id, mode) => { events.push(['cancel', id, mode]) },
    setTimeout: (resolve) => { context.batchCancelled = true; resolve() },
    ElMessage: { warning(message) { assert.fail(message) }, error(message) { assert.fail(message) } }
  }
  const run = await workbenchFunction('exportSparkResult', context)
  await run()
  assert.deepEqual(events, [['submit', 'session'], ['poll', 'export-session', 'session'], ['cancel', 'export-session', 'session']])
  assert.equal(context.currentSparkJob.value, null)
  assert.equal(context.exportLoading.value, false)
})
