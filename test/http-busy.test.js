import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHttpRoutes, HTTP_ROUTES } from '../src/http.js'

const config = {
  package: 'dsh-config-git-sync',
  remote: 'https://example.com/repo.git',
  branch: 'main',
  profile: 'demo',
}

async function call(routes, path, init = {}) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route, `route ${path} exists`)
  const request = new Request(`http://localhost${path}`, {
    method: init.method || 'GET',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { 'content-type': 'application/json' },
  })
  const response = await route.fetch(request)
  return { response, body: await response.json() }
}

test('status reports the busy state and the last activity instead of failing', async () => {
  const routes = createHttpRoutes(config, {
    status: async () => 'should not be reached',
    isBusy: async () => true,
    readActivity: async () => ({ action: 'push', startedAt: 'now', finishedAt: null, ok: null, text: '' }),
  })
  const result = await call(routes, HTTP_ROUTES.status)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.busy, true)
  assert.equal(result.body.activity.action, 'push')
  // The card must not render a stale/empty status text in the busy state.
  assert.equal(result.body.text, '')
})

test('status merges the last finished activity for remount recovery', async () => {
  const routes = createHttpRoutes(config, {
    status: async () => 'Config sync status',
    isBusy: async () => false,
    readActivity: async () => ({ action: 'pull', startedAt: null, finishedAt: 'earlier', ok: true, text: 'Config sync pull' }),
  })
  const result = await call(routes, HTTP_ROUTES.status)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.busy, undefined)
  assert.equal(result.body.text, 'Config sync status')
  assert.equal(result.body.activity.action, 'pull')
  assert.equal(result.body.activity.text, 'Config sync pull')
})

test('E_BUSY maps to HTTP 409 with a structured busy flag', async () => {
  const busy = new Error('another config sync is running')
  busy.code = 'E_BUSY'
  const routes = createHttpRoutes(config, {
    push: async () => {
      throw busy
    },
  })
  const result = await call(routes, HTTP_ROUTES.push, { method: 'POST', body: {} })
  assert.equal(result.response.status, 409)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'E_BUSY')
  assert.equal(result.body.busy, true)
})

test('the probe route reports success and failures like the other actions', async () => {
  const routes = createHttpRoutes(config, {
    probe: async () => 'Connection test passed',
  })
  const result = await call(routes, HTTP_ROUTES.probe, { method: 'POST', body: {} })
  assert.equal(result.body.ok, true)
  assert.equal(result.body.text, 'Connection test passed')
})

test('the probe route surfaces E_CONFIG', async () => {
  const error = new Error('no git remote configured')
  error.code = 'E_CONFIG'
  const routes = createHttpRoutes(config, {
    probe: async () => {
      throw error
    },
  })
  const result = await call(routes, HTTP_ROUTES.probe, { method: 'POST', body: {} })
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'E_CONFIG')
  assert.equal(result.body.message, 'no git remote configured')
})
