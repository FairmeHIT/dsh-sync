import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SyncError } from '../src/errors.js'
import { HTTP_ROUTES, createHttpRoutes } from '../src/http.js'

const config = {
  remote: 'https://user:secret@example.com/me/config.git?token=top-secret',
  branch: 'main',
  profile: 'desktop',
}

function route(routes, path) {
  const found = routes.find((item) => item.path === path)
  assert.ok(found, `missing route ${path}`)
  return found
}

async function call(routes, path, { method = 'GET', body } = {}) {
  const request = new Request(`http://127.0.0.1${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const response = await route(routes, path).fetch(request)
  return { response, body: await response.json() }
}

test('configuration GET works without remote and never calls Git', async () => {
  const routes = createHttpRoutes({ remote: '', branch: 'main' }, {})
  const { body } = await call(routes, '/api/config-sync/config')
  assert.equal(body.ok, true)
  assert.equal(body.remote, '')
  assert.equal(body.branch, 'main')
  assert.equal(body.persistence, 'profile-patch')
})

test('configuration POST validates before saving and reports accepted, not verified', async () => {
  let saved
  const routes = createHttpRoutes(config, {}, { save: async (value) => { saved = value } })
  const fields = { remote: 'git@example.com:me/config.git', branch: 'main', profile: '' }
  const { response, body } = await call(routes, '/api/config-sync/config', { method: 'POST', body: fields })
  assert.equal(response.status, 202)
  assert.equal(body.accepted, true)
  assert.equal(body.verified, false)
  assert.deepEqual(saved, fields)
  const invalid = await call(routes, '/api/config-sync/config', { method: 'POST', body: { ...fields, remote: 'https://u:secret@example.com/a' } })
  assert.equal(invalid.response.status, 400)
  assert.doesNotMatch(JSON.stringify(invalid.body), /secret/)
})

test('configuration save errors and invalid JSON do not echo raw errors', async () => {
  const routes = createHttpRoutes(config, {}, { save: async () => { throw new Error('secret') } })
  const result = await call(routes, '/api/config-sync/config', { method: 'POST', body: { remote: '', branch: 'main', profile: '' } })
  assert.equal(result.body.ok, false)
  assert.doesNotMatch(JSON.stringify(result.body), /secret/)
  const invalid = await call(routes, '/api/config-sync/config', { method: 'POST', body: '{secret' })
  assert.equal(invalid.response.status, 400)
  assert.doesNotMatch(JSON.stringify(invalid.body), /secret/)
})

describe('config-sync HTTP routes', () => {
  test('declares one exact method per path', () => {
    const routes = createHttpRoutes(config, {
      status: async () => 'status text',
      push: async () => 'push text',
      pull: async () => 'pull text',
    })
    assert.deepEqual(
      routes.map((item) => [item.path, item.methods]),
      [
        [HTTP_ROUTES.status, ['GET']],
        [HTTP_ROUTES.push, ['POST']],
        [HTTP_ROUTES.pull, ['POST']],
        [HTTP_ROUTES.config, ['GET', 'POST']],
      ],
    )
    for (const item of routes) assert.equal(item.requestBody, 'buffered')
  })

  test('status returns the text and masks credentials in the remote URL', async () => {
    const routes = createHttpRoutes(config, {
      status: async (value) => {
        assert.equal(value, config)
        return 'Config sync status\nremote commit: abc'
      },
      push: async () => '',
      pull: async () => '',
    })
    const { response, body } = await call(routes, HTTP_ROUTES.status)
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.text, 'Config sync status\nremote commit: abc')
    assert.equal(body.profile, 'desktop')
    assert.equal(body.branch, 'main')
    assert.doesNotMatch(body.remote, /secret|pass|top-secret/)
    assert.match(body.remote, /example\.com/)
  })

  test('push forwards a trimmed message and the force flag', async () => {
    let seen
    const routes = createHttpRoutes(config, {
      status: async () => '',
      push: async (_config, options) => {
        seen = options
        return 'pushed'
      },
      pull: async () => '',
    })
    const { body } = await call(routes, HTTP_ROUTES.push, {
      method: 'POST',
      body: { message: '  from the card  ', force: true },
    })
    assert.equal(body.ok, true)
    assert.equal(body.text, 'pushed')
    assert.deepEqual(seen, { message: 'from the card', force: true })
  })

  test('pull defaults to a dry run and accepts apply', async () => {
    const seen = []
    const routes = createHttpRoutes(config, {
      status: async () => '',
      push: async () => '',
      pull: async (_config, options) => {
        seen.push(options.apply)
        return options.apply ? 'applied' : 'preview'
      },
    })
    const preview = await call(routes, HTTP_ROUTES.pull, { method: 'POST', body: {} })
    assert.equal(preview.body.text, 'preview')
    const applied = await call(routes, HTTP_ROUTES.pull, { method: 'POST', body: { apply: true } })
    assert.equal(applied.body.text, 'applied')
    assert.deepEqual(seen, [false, true])
  })

  test('reports sync failures without leaking credentials', async () => {
    const routes = createHttpRoutes(config, {
      status: async () => {
        throw new SyncError('E_CONFIG', 'no git remote configured')
      },
      push: async () => '',
      pull: async () => '',
    })
    const { response, body } = await call(routes, HTTP_ROUTES.status)
    assert.equal(response.status, 200)
    assert.equal(body.ok, false)
    assert.equal(body.code, 'E_CONFIG')
    assert.match(body.message, /no git remote configured/)
    assert.doesNotMatch(JSON.stringify(body), /secret|pass|top-secret/)
  })

  test('rejects malformed bodies with a request error', async () => {
    const routes = createHttpRoutes(config, {
      status: async () => '',
      push: async () => 'should not run',
      pull: async () => '',
    })
    const broken = await call(routes, HTTP_ROUTES.push, { method: 'POST', body: '{' })
    assert.equal(broken.response.status, 400)
    assert.equal(broken.body.code, 'E_REQUEST')

    const wrongType = await call(routes, HTTP_ROUTES.pull, {
      method: 'POST',
      body: { apply: 'yes' },
    })
    assert.equal(wrongType.response.status, 400)
    assert.equal(wrongType.body.code, 'E_REQUEST')
  })
})
