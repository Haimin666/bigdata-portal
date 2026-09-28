import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuthGate, createModuleGate } from '../middleware/auth-gate.js'
import { createExecGate } from '../middleware/exec-gate.js'

function makeAuth(currentUser = null) {
  const user = typeof currentUser === 'function' ? currentUser : () => currentUser
  return {
    enabled: true,
    currentUser: user,
    users: {
      isEmpty: () => false,
      modulesOf: () => null
    }
  }
}

function makeRequest(path, method = 'GET', token = 'db-token') {
  return {
    path,
    method,
    headers: token ? { 'x-api-token': token } : {},
    body: {},
    user: undefined
  }
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

function run(middleware, req) {
  const res = makeResponse()
  let continued = false
  middleware(req, res, () => { continued = true })
  return { res, continued }
}

const options = {
  dbQueryApiToken: 'db-token',
}

test('database API token authenticates only on an explicitly allowed Impala route', () => {
  const req = makeRequest('/api/db/jobs', 'POST')
  const result = run(createAuthGate(makeAuth(), options), req)

  assert.equal(result.continued, true)
  assert.deepEqual(req.dbQueryApiPrincipal, {
    id: 'db-query-api',
    role: 'db-query-api',
    routeScope: 'impala'
  })
})

test('database API token is rejected on routes outside the Impala/Spark query allowlist', () => {
  const req = makeRequest('/api/flink/query', 'POST')
  const result = run(createAuthGate(makeAuth(), options), req)

  assert.equal(result.continued, false)
  assert.equal(result.res.statusCode, 403)
})

test('valid database API token cannot access database permission administration', () => {
  const req = makeRequest('/api/db-perms', 'GET')
  const result = run(createAuthGate(makeAuth(), options), req)

  assert.equal(result.continued, false)
  assert.equal(result.res.statusCode, 403)
})

test('database API principal passes module and execution gates only after route authentication', () => {
  const auth = makeAuth()
  const req = makeRequest('/api/db/jobs', 'POST')
  req.dbQueryApiPrincipal = { id: 'db-query-api', role: 'db-query-api' }
  req.apiTokenAuthenticated = true

  assert.equal(run(createModuleGate(auth), req).continued, true)
  assert.equal(run(createExecGate(auth), req).continued, true)
})

test('ordinary cookie-authenticated users retain the existing route path', () => {
  const user = { username: 'alice', role: 'dev' }
  const req = makeRequest('/api/db/acl', 'GET', null)
  const result = run(createAuthGate(makeAuth(user), options), req)

  assert.equal(result.continued, true)
  assert.equal(req.user, user)
  assert.equal(req.dbQueryApiPrincipal, undefined)
})

test('configured database API token keeps its restricted scope when portal login is disabled', () => {
  const req = makeRequest('/api/flink/query', 'POST')
  const result = run(createAuthGate({ ...makeAuth(), enabled: false }, options), req)

  assert.equal(result.continued, false)
  assert.equal(result.res.statusCode, 403)
})
