import test from 'node:test'
import assert from 'node:assert/strict'
import { hasExecutableSql } from '../src/utils/sql-query-comments.js'

test('keeps executable SQL after leading line and block comments', () => {
  assert.equal(hasExecutableSql('-- note\nSELECT 1'), true)
  assert.equal(hasExecutableSql('/* note */ SELECT 1'), true)
  assert.equal(hasExecutableSql('  -- first\n /* second */ SHOW TABLES'), true)
})

test('filters whitespace and comment-only segments', () => {
  assert.equal(hasExecutableSql('  \n -- note\n '), false)
  assert.equal(hasExecutableSql(' /* note */ '), false)
})
