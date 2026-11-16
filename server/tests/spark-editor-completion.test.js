import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import * as sqlCompletions from '../../src/utils/sql-editor-completions.ts'

// Run the component's actual setup/provider; replace only Vue/Monaco lifecycle
// and network boundaries so metadata timing and cache behavior stay observable.
function editorHarness(initialProps, options = {}) {
  const props = { modelId: 'test', currentDb: 'spark', engine: 'sparksql', executionMode: 'session', ...initialProps }
  let provider
  let activeModel
  let activeLine = ''
  const refreshes = []
  let source = fs.readFileSync(new URL('../../src/views/db/SqlEditor.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  source = source.replace(/^import[\s\S]*? from ['"][^'"]+['"]\n/gm, '')
  const context = {
    ...sqlCompletions,
    // 单点号前缀可能是「库.表」也可能是「表.列」:组件会查一次库清单做消歧
    listSparkDatabases: options.listSparkDatabases ?? (async (...args) => {
      (context.sparkDatabases ||= []).push(args)
      return ['analytics', 'other', 'default']
    }),
    defineProps: () => props, withDefaults: (value) => value, defineEmits: () => () => {}, defineExpose() {},
    ref: (value) => ({ value }), onMounted() {}, onBeforeUnmount() {}, definePortalThemes() {},
    watch: (read, callback, options) => { if (options?.immediate) callback(read()) },
    monaco: {
      editor: { setTheme() {} },
      languages: {
        CompletionItemKind: { Keyword: 1, Function: 2, Field: 3, Class: 4, Text: 5, Snippet: 6 },
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerCompletionItemProvider: (_language, value) => { provider = value; return { dispose() {} } }
      }
    }
  }
  runInNewContext(stripTypeScriptTypes(source) + '\nregisterProvider("sql"); globalThis.attachEditor = (value) => { editor = value }', context)
  context.attachEditor({
    getModel: () => activeModel,
    getPosition: () => ({ lineNumber: 1, column: activeLine.length + 1 }),
    trigger: (...args) => refreshes.push(args)
  })
  return {
    props, refreshes,
    complete(line) {
      const model = { id: line, uri: { scheme: 'portal-sql' }, getLanguageId: () => 'sql', getLineCount: () => 1, getLineContent: () => line }
      activeModel = model
      activeLine = line
      return provider.provideCompletionItems(model, { lineNumber: 1, column: line.length + 1 })
    }
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('Spark editor keeps unqualified/local completion immediate without schema prefetch', async () => {
  const requests = []
  const h = editorHarness({ schemaLoader: (...args) => { requests.push(args); return new Promise(() => {}) } })
  for (const [input, label] of [['SEL', 'SELECT'], ['CON', 'CONCAT'], ['customer_code, cust', 'customer_code']]) {
    const result = h.complete(input)
    assert.equal(typeof result.then, 'undefined', 'local candidates must not await metadata')
    assert.ok(result.suggestions.some((item) => item.label === label), input)
  }
  h.complete("SELECT 'analytics.'")
  h.complete('-- analytics.')
  assert.deepEqual(requests, [], 'virtual spark datasource and unqualified SQL must never load schema')
})

test('qualified Spark completion isolates mode/catalog/table caches and pending responses', async () => {
  const requests = []
  const pending = []
  const h = editorHarness({ schemaLoader: (...args) => {
    requests.push([...args])
    return new Promise((resolve) => pending.push(resolve))
  } })
  assert.equal(h.complete('SELECT * FROM analytics.').suggestions.length, 0)
  await settle()
  await settle()
  h.complete('SELECT * FROM analytics.ev')
  await settle()
  // 单点号前缀先按「库.」猜(库清单尚未加载时),拿到清单后确认是库名,不再重复请求
  assert.deepEqual(requests, [['analytics', 'sparksql', 'session', undefined]], 'same catalog request is deduplicated')
  h.props.executionMode = 'thrift'
  h.complete('SELECT * FROM analytics.')
  await settle()
  await settle()
  assert.deepEqual(requests.at(-1), ['analytics', 'sparksql', 'thrift', undefined])
  const refreshesBeforeLateSession = h.refreshes.length
  pending[0]({ tables: [{ name: 'session_events', columns: [] }] })
  await settle()
  assert.equal(h.refreshes.length, refreshesBeforeLateSession, 'late Session response must not reopen completion in Thrift')
  assert.equal(h.complete('SELECT * FROM analytics.').suggestions.length, 0, 'late Session response cannot populate Thrift')
  pending[1]({ tables: [{ name: 'thrift_events', columns: [] }] })
  await settle()
  assert.ok(h.refreshes.length > refreshesBeforeLateSession, 'loaded metadata refreshes the active completion without another keystroke')
  assert.deepEqual(Array.from(h.complete('SELECT * FROM analytics.th').suggestions, (item) => item.label), ['thrift_events'])
  h.props.executionMode = 'session'
  assert.deepEqual(Array.from(h.complete('SELECT * FROM analytics.se').suggestions, (item) => item.label), ['session_events'])
  h.complete('SELECT analytics.events.')
  await settle()
  await settle()
  h.complete('SELECT analytics.events.ev')
  assert.deepEqual(requests.at(-1), ['analytics', 'sparksql', 'session', 'events'])
  assert.equal(requests.length, 3)
  pending[2]({ tables: [{ name: 'events', columns: [{ name: 'event_id', type: 'bigint' }] }] })
  await settle()
  const fields = h.complete('SELECT `analytics`.`events`.ev').suggestions
  assert.equal(fields[0].label, 'event_id')
  assert.match(fields[0].detail, /bigint/)
  h.complete('SELECT other.events.')
  await settle()
  await settle()
  assert.deepEqual(requests.at(-1), ['other', 'sparksql', 'session', 'events'])
  h.props.engine = 'mysql'
  h.props.currentDb = 'analytics'
  h.complete('SELECT se')
  await settle()
  assert.equal(requests.at(-1)[0], 'analytics', 'relational schema loads independently')
  assert.equal(requests.at(-1)[1], 'mysql', 'loader routes by the snapshotted engine, not the live ref')
  assert.equal(requests.length, 5)
})

test('workbench completion loader uses selected Spark tables/fields APIs and preserves relational schema', async () => {
  const source = fs.readFileSync(new URL('../../src/views/db/QueryView.vue', import.meta.url), 'utf8')
  const loader = source.slice(source.indexOf('const schemaLoader ='), source.indexOf('// 默认 SQL:'))
  const requests = []
  const context = {
    engine: { value: 'sparksql' }, sparkExecutionMode: { value: 'session' },
    getSchema: async (...args) => { requests.push(['relational', ...args]); return { tables: [] } },
    listSparkTables: async (...args) => { requests.push(['tables', ...args]); return ['events'] },
    listSparkFields: async (...args) => { requests.push(['fields', ...args]); return [{ name: 'event_id', type: 'bigint' }] }
  }
  runInNewContext(stripTypeScriptTypes(loader) + '\nglobalThis.load = schemaLoader', context)
  const tables = await context.load('analytics', 'sparksql', 'session')
  assert.deepEqual(requests, [['tables', 'analytics', 'session']])
  assert.equal(tables.tables[0].name, 'events')
  const fields = await context.load('analytics', 'sparksql', 'thrift', 'events')
  assert.equal(fields.tables[0].columns[0].name, 'event_id')
  assert.deepEqual(requests, [['tables', 'analytics', 'session'], ['fields', 'analytics', 'events', 'thrift']])
  // 竞态修复:路由以调用方显式传入的 engine 为准,不受实时 ref 变化影响
  context.engine.value = 'sparksql'
  await context.load('orders', 'mysql')
  assert.deepEqual(requests.at(-1), ['relational', 'orders'])
})

test('ambiguous single-dot prefix falls back from catalog guess to table.column', async () => {
  const requests = []
  let resolveDatabases
  const databases = new Promise((resolve) => { resolveDatabases = resolve })
  const h = editorHarness(
    { schemaLoader: async (...args) => {
      requests.push([...args])
      if (args[0] === 'default') {
        return { tables: [{ name: 'emp', columns: [{ name: 'id', type: 'bigint' }] }] }
      }
      return null // 不存在名为 emp 的库
    } },
    { listSparkDatabases: () => databases } // 库清单挂起:先走「猜库」路径
  )
  h.complete('SELECT * FROM emp.id')
  await settle()
  assert.deepEqual(requests.at(-1), ['emp', 'sparksql', 'session', undefined], '库清单未知时先按最常见的 库. 猜测')
  resolveDatabases(['analytics', 'other', 'default'])
  await settle()
  await settle()
  assert.deepEqual(requests.at(-1), ['default', 'sparksql', 'session', 'emp'], '库清单确认非库名后回退 表.列')
  const after = h.complete('SELECT * FROM emp.id').suggestions
  assert.ok(after.some((item) => item.label === 'id'), '回退后按表.列给出字段补全')
})
