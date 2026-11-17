import { PACKAGE_NAME } from './config.js'
import { displayRemote } from './git.js'
import { publicConfig, validateRemoteFields } from './remote-config.js'

/**
 * Exact paths below the DSH web API prefix. The client card calls these with
 * the same paths, so keep the constants in one place.
 */
export const HTTP_ROUTES = Object.freeze({
  status: '/api/config-sync/status',
  push: '/api/config-sync/push',
  pull: '/api/config-sync/pull',
  config: '/api/config-sync/config',
})

class BadRequest extends Error {
  constructor(message) {
    super(message)
    this.code = 'E_REQUEST'
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function identity(config) {
  return {
    package: PACKAGE_NAME,
    remote: displayRemote(config.remote),
    branch: String(config.branch ?? 'main'),
    profile: String(config.profile ?? ''),
  }
}

function failure(config, error, status = 200) {
  return json(
    {
      ok: false,
      ...identity(config),
      code: error?.code ?? 'E_SYNC',
      message: error?.message ?? String(error),
    },
    status,
  )
}

async function readBody(request) {
  const text = await request.text()
  if (!text.trim()) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new BadRequest('request body is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequest('request body must be a JSON object')
  }
  return value
}

function optionalBoolean(body, key) {
  if (body[key] === undefined) return false
  if (typeof body[key] !== 'boolean') throw new BadRequest(`${key} must be a boolean`)
  return body[key]
}

function optionalMessage(body) {
  if (body.message === undefined || body.message === null) return ''
  if (typeof body.message !== 'string') throw new BadRequest('message must be a string')
  return body.message.trim().slice(0, 500)
}

/**
 * Build Fetch routes for the Plugins-page card. Operations are injected so the
 * HTTP layer stays testable without a Git remote.
 */
/**
 * Detect the "nothing changed" outcome without relying on the human-facing
 * report text: the sync module uses these exact trailing lines.
 */
const UP_TO_DATE_LINES = new Set([
  'Already up to date.',
  'Already up to date; nothing to commit.',
])

function upToDate(text) {
  return String(text || '')
    .split('\n')
    .some((line) => UP_TO_DATE_LINES.has(line.trim()))
}

export function createHttpRoutes(config, operations, editor) {
  async function configRoute(request) {
    if (request.method === 'GET') return json({ ok: true, ...publicConfig(config) })
    try {
      const fields = validateRemoteFields(await readBody(request))
      if (!editor) return json({ ok: false, code: 'E_CONFIG_EDITOR', message: 'Configuration editor is unavailable.' }, 503)
      await editor.save(fields)
      // Reconciliation may dispose this handler: clients must GET the new instance.
      return json({ ok: true, accepted: true, verified: false }, 202)
    } catch (error) {
      const known = ['E_CONFIG_INPUT', 'E_CONFIG_EDITOR', 'E_CONFIG_BUSY', 'E_CONFIG_SAVE'].includes(error?.code)
      return json({ ok: false, code: known ? error.code : 'E_CONFIG_SAVE', message: known ? error.message : 'Configuration could not be saved. Retry after reload.' }, error instanceof BadRequest || error?.code === 'E_CONFIG_INPUT' ? 400 : 409)
    }
  }

  async function statusRoute() {
    try {
      const text = await operations.status(config)
      return json({ ok: true, ...identity(config), text, upToDate: upToDate(text) })
    } catch (error) {
      return failure(config, error)
    }
  }

  async function pushRoute(request) {
    let body
    try {
      body = await readBody(request)
      const message = optionalMessage(body)
      const force = optionalBoolean(body, 'force')
      const text = await operations.push(config, { message, force })
      return json({ ok: true, ...identity(config), text, upToDate: upToDate(text) })
    } catch (error) {
      return failure(config, error, error instanceof BadRequest ? 400 : 200)
    }
  }

  async function pullRoute(request) {
    let body
    try {
      body = await readBody(request)
      const apply = optionalBoolean(body, 'apply')
      const text = await operations.pull(config, { apply })
      return json({ ok: true, ...identity(config), text, upToDate: upToDate(text) })
    } catch (error) {
      return failure(config, error, error instanceof BadRequest ? 400 : 200)
    }
  }

  return [
    {
      path: HTTP_ROUTES.status,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: statusRoute,
    },
    {
      path: HTTP_ROUTES.push,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: pushRoute,
    },
    {
      path: HTTP_ROUTES.pull,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: pullRoute,
    },
    {
      path: HTTP_ROUTES.config,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: configRoute,
    },
  ]
}
