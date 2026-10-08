import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractSqlStringLiterals,
  getSingleQuotedPrefix,
  filterSqlStringValues,
  scanSqlStringLine,
  isSqlCommentPosition,
  shouldAutoTriggerSqlCompletion
} from '../src/utils/sql-editor-completions.ts'

test('extracts only closed SQL single-quoted values outside comments', () => {
  const sql = `select 'success', 'it''s ok', 'it\\'s fine' -- 'ignored'\n/* 'also ignored' */ where x = 'success' and y = 'unfinished`
  assert.deepEqual(extractSqlStringLiterals(sql), ['success', "it's ok", "it's fine", 'success'])
})

test('detects the current single-quoted prefix but not comments or closed strings', () => {
  assert.deepEqual(getSingleQuotedPrefix("where state = 'suc", 19), { prefix: 'suc', startColumn: 16 })
  assert.equal(getSingleQuotedPrefix("-- state = 'suc", 16), null)
  assert.equal(getSingleQuotedPrefix("where state = 'success'", 24), null)
})

test('filters string values by exact-case prefix and caps the candidate list', () => {
  assert.deepEqual(filterSqlStringValues(['success', 'Success', 'successful'], 'suc', 1), ['success'])
})

test('carries block-comment state across lines when indexing string values', () => {
  const first = scanSqlStringLine('/* hidden', false)
  const second = scanSqlStringLine("'hidden too' */ 'visible'", first.inBlockComment)
  assert.deepEqual(first.values, [])
  assert.deepEqual(second.values, ['visible'])
})

test('does not offer completions inside line or block comments', () => {
  assert.equal(isSqlCommentPosition("select 1 -- 'not a string", 27), true)
  assert.equal(isSqlCommentPosition("'-- not a comment'", 19), false)
  assert.equal(isSqlCommentPosition("'value' /* comment", 20), true)
})

test('automatically triggers code and string suggestions while typing SQL', () => {
  assert.equal(shouldAutoTriggerSqlCompletion('sel', 4), true)
  assert.equal(shouldAutoTriggerSqlCompletion('orders.', 8), true)
  assert.equal(shouldAutoTriggerSqlCompletion("where status = 's", 18), true)
  assert.equal(shouldAutoTriggerSqlCompletion("where status = '", 17), false)
  assert.equal(shouldAutoTriggerSqlCompletion('-- sel', 7), false)
  assert.equal(shouldAutoTriggerSqlCompletion('select ', 8), false)
})
