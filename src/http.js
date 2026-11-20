import { PACKAGE_NAME } from './config.js'
import { SyncError } from './errors.js'
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
  probe: '/api/config-sync/probe',
  update: '/api/config-sync/update',
  updateState: '/api/config-sync/update-state',
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
  // A held lock means another sync is already running: report it as 409 with
  // the structured flag the card needs, so the UI can say "busy" instead of
  // surfacing a generic error (pattern from dsh-plugin-account-sync).
  if (error?.code === 'E_BUSY') {
    return json({ ok: false, ...identity(config), code: 'E_BUSY', message: error.message, busy: true }, 409)
  }
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

function optionalString(body, key) {
  if (body[key] === undefined || body[key] === null) return ''
  if (typeof body[key] !== 'string') throw new BadRequest(`${key} must be a string`)
  return body[key].trim().slice(0, 200)
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
    // Remount recovery: report an in-flight sync and the last outcome so a
    // freshly mounted card restores the real state instead of showing "idle"
    // over a running push (syncup's cached=1 equivalent).
    const busy = operations.isBusy ? await operations.isBusy() : false
    if (busy) {
      const activity = operations.readActivity ? await operations.readActivity() : null
      return json({ ok: true, ...identity(config), busy: true, activity, text: '' })
    }
    try {
      // statusReport() also names the effective profile/channel and, for a
      // remote that holds other profile directories, the names it found.
      const run = operations.statusReport ?? operations.status
      const report = await run(config)
      const text = typeof report === 'string' ? report : String(report?.text ?? '')
      const activity = operations.readActivity ? await operations.readActivity() : null
      const details =
        typeof report === 'string'
          ? {}
          : {
              profile: report?.profile,
              channel: report?.channel,
              remoteProfiles: report?.remoteProfiles,
              adopted: report?.adopted === true,
            }
      return json({ ok: true, ...identity(config), text, upToDate: upToDate(text), activity, ...details })
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
      // `force` accepts a destructive pull; `expectedCommit` binds an apply to
      // the preview the user actually reviewed.
      const force = optionalBoolean(body, 'force')
      const expectedCommit = optionalString(body, 'expectedCommit')
      // pullReport() is preferred because it also carries the facts the card
      // needs to name the follow-up step; a plain pull() still returns text.
      const run = operations.pullReport ?? operations.pull
      const report = await run(config, { apply, force, expectedCommit })
      const text = typeof report === 'string' ? report : String(report?.text ?? '')
      return json({
        ok: true,
        ...identity(config),
        text,
        upToDate: upToDate(text),
        needsInstall: typeof report === 'string' ? false : report?.needsInstall === true,
        profile: typeof report === 'string' ? undefined : report?.profile,
        channel: typeof report === 'string' ? undefined : report?.channel,
        adopted: typeof report === 'string' ? undefined : report?.adopted === true,
        commit: typeof report === 'string' ? undefined : report?.commit,
        snapshot: typeof report === 'string' ? undefined : report?.snapshot,
        destructive: typeof report === 'string' ? false : report?.destructive === true,
        missing: typeof report === 'string' ? undefined : report?.missing,
      })
    } catch (error) {
      return failure(config, error, error instanceof BadRequest ? 400 : 200)
    }
  }

  async function probeRoute() {
    try {
      const text = await operations.probe(config)
      return json({ ok: true, ...identity(config), text })
    } catch (error) {
      return failure(config, error)
    }
  }

  /**
   * The plugin's own version and, when it was installed from GitHub, the
   * version that repository publishes now. Read-only, so the card may call it
   * on every mount.
   */
  async function updateCheckRoute() {
    try {
      return json(await operations.checkUpdate(config))
    } catch (error) {
      return failure(config, error)
    }
  }

  /**
   * Start replacing this plugin with the published version. The installation
   * unloads the plugin serving this request, so the answer is an acceptance:
   * the card follows the outcome through updateStateRoute.
   */
  async function updateStartRoute(request) {
    try {
      await readBody(request)
      // A running sync holds the lock and, often, a Git process on the profile
      // this update would reinstall underneath. Refuse instead of racing it.
      if (operations.isBusy && (await operations.isBusy())) {
        throw new SyncError('E_BUSY', 'a sync is running; update after it finishes')
      }
      const result = await operations.startUpdate(config)
      return json({ ok: true, ...identity(config), accepted: true, from: result.from, to: result.to }, 202)
    } catch (error) {
      return failure(config, error, error instanceof BadRequest ? 400 : 200)
    }
  }

  async function updateStateRoute() {
    try {
      const update = await operations.readUpdateState(config)
      return json({ ok: true, ...identity(config), update })
    } catch (error) {
      return failure(config, error)
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
      path: HTTP_ROUTES.probe,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: probeRoute,
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
    {
      path: HTTP_ROUTES.update,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => (request.method === 'POST' ? updateStartRoute(request) : updateCheckRoute()),
    },
    {
      path: HTTP_ROUTES.updateState,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: updateStateRoute,
    },
  ]
}
