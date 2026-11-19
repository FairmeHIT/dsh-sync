import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_NAME, resolveDshHome } from './config.js'
import { SyncError } from './errors.js'
import { detectProfile, readJson, writeFileAtomic } from './paths.js'
/** Where the outcome of the last update lives, beside activity.json. */
export const UPDATE_STATE_FILE = 'update.json'
export const UPDATE_STATE_VERSION = 1

const DEFAULT_BRANCH = 'main'
const RAW_HOST = 'https://raw.githubusercontent.com'
const CHECK_TIMEOUT_MS = 15_000
const GIT_TIMEOUT_MS = 20_000
/** A "running" record older than this lost its installer; report it as failed. */
const STALE_RUNNING_MS = 3 * 60_000
const OWN_PACKAGE = new URL('../package.json', import.meta.url)

/**
 * The installed version of this plugin. The bundle actually loading from
 * `node_modules` may lag after a manual edit, so the manifest on disk is the
 * honest answer for "what am I running now".
 */
export async function ownPackageVersion() {
  try {
    const pkg = JSON.parse(await readFile(OWN_PACKAGE, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/**
 * The GitHub repository an install spec points at, or null when the spec is a
 * local path, a registry name, or another host. A spec that pins a full commit
 * keeps the pin; otherwise the branch to read is the one the spec names, or
 * `main`.
 */
export function parseGitHubSource(source) {
  const raw = String(source ?? '').trim()
  if (!raw) return null
  const patterns = [
    /^github:([\w.-]+)\/([\w.-]+?)(?:#(.+))?$/,
    /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/)?(?:#(.+))?$/,
    /^(?:git\+ssh:\/\/)?git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.+))?$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(raw)
    if (!match) continue
    const owner = match[1]
    const repo = match[2].replace(/\.git$/i, '')
    const ref = String(match[3] ?? '').trim()
    const commit = /^[0-9a-f]{40}$/i.test(ref) ? ref.toLowerCase() : ''
    return {
      owner,
      repo,
      ref,
      commit,
      branch: !ref || commit ? DEFAULT_BRANCH : ref,
    }
  }
  return null
}

function versionParts(version) {
  const text = String(version ?? '').trim().replace(/^v/i, '')
  const withoutBuild = text.split('+')[0]
  const dash = withoutBuild.indexOf('-')
  const core = dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)
  const prerelease = dash < 0 ? '' : withoutBuild.slice(dash + 1)
  const numbers = core.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
  while (numbers.length < 3) numbers.push(0)
  return { numbers: numbers.slice(0, 3), prerelease }
}

/**
 * Compare two semver versions: -1 when the first is older, 0 when equal, 1 when
 * newer. A prerelease sorts before its release, exactly as pnpm and npm do.
 */
export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

export function updateStatePath(config) {
  return join(resolveDshHome(config), 'config-sync', UPDATE_STATE_FILE)
}

/** The last update attempt, or null when there is none or it is unreadable. */
export async function readUpdateState(config) {
  let raw
  try {
    raw = await readJson(updateStatePath(config))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== UPDATE_STATE_VERSION) return null
  const status = raw.status === 'running' || raw.status === 'done' || raw.status === 'failed' ? raw.status : 'failed'
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : null
  // A crash or a killed host leaves "running" behind forever; the card would
  // poll a state nobody updates, so an old record reads as an interrupted run.
  const stale = status === 'running' && startedAt !== null && Date.now() - Date.parse(startedAt) > STALE_RUNNING_MS
  return {
    status: stale ? 'failed' : status,
    from: typeof raw.from === 'string' ? raw.from : '',
    to: typeof raw.to === 'string' ? raw.to : '',
    startedAt,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    application: typeof raw.application === 'string' ? raw.application : '',
    message: stale
      ? 'the update did not finish; the previous version is still installed'
      : typeof raw.message === 'string'
        ? raw.message
        : '',
  }
}

async function writeUpdateState(config, state) {
  try {
    await writeFileAtomic(
      updateStatePath(config),
      JSON.stringify({ schemaVersion: UPDATE_STATE_VERSION, ...state }),
    )
  } catch {
    // The state file is a UI aid; a failed write must not break the update.
  }
}

/** The spec this machine installed the plugin with, from its profile manifest. */
async function installedSpec(config) {
  const dshHome = resolveDshHome(config)
  const profile = await detectProfile(dshHome, config.profile, PACKAGE_NAME)
  const manifest = await readJson(join(dshHome, 'profiles', profile, 'package.json'))
  const spec = manifest?.dependencies?.[PACKAGE_NAME]
  return { profile, spec: typeof spec === 'string' ? spec : '' }
}

async function defaultFetchText(url, timeoutMs = CHECK_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the plugin manager at the moment of use. It is a lazy service: a
 * one-shot `ctx.get` on the plugin's outer context misses it on the desktop
 * host, which left the card reporting "no plugin manager" and doing nothing.
 * Probe every context we were handed, then let Cordis start the service and
 * ask again under a deadline. Callers get a definite answer either way.
 */
export function createManagerProbe(ctx, deps = {}) {
  const timeoutMs = deps.timeoutMs ?? 5_000
  const extra = []
  const candidates = () => [deps.context, ...extra, ctx]

  const read = () => {
    for (const context of candidates()) {
      try {
        const manager = typeof context?.get === 'function' ? context.get('pluginManager') : undefined
        if (manager && typeof manager.installBundle === 'function') return manager
      } catch {}
    }
    return undefined
  }

  /** A context that can see the service, so later reads skip the wait. */
  const adopt = (context) => {
    if (context && context !== ctx && !extra.includes(context)) extra.push(context)
  }

  const get = () => read()

  const ensure = async () => {
    const immediate = get()
    if (immediate) return immediate
    if (typeof ctx?.inject !== 'function') return undefined
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      try {
        ctx.inject(['pluginManager'], (scope) => {
          adopt(scope)
          finish()
        })
      } catch {
        finish()
      }
    })
    return get()
  }

  return { get, ensure, adopt }
}

async function defaultRunGit(args, timeoutMs = GIT_TIMEOUT_MS) {
  return await new Promise((resolve, reject) => {
    execFile('git', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new SyncError('E_UPDATE_GIT', String(stderr ?? '').trim() || error.message))
        return
      }
      resolve(String(stdout ?? ''))
    })
  })
}

/**
 * Where the published manifest can be read. `raw.githubusercontent.com` is the
 * canonical host but it is unreachable from networks that block it (mainland
 * China among them, where it times out rather than resolves), so the card tries
 * mirrors in order and stops at the first one that answers. Every entry returns
 * the same `package.json`, so a mirror cannot skew the version.
 */
function manifestUrls(repo) {
  const { owner, repo: name, branch } = repo
  const base = `gh/${owner}/${name}@${branch}/package.json`
  return [
    `${RAW_HOST}/${owner}/${name}/${branch}/package.json`,
    `https://cdn.jsdelivr.net/${base}`,
    `https://gcore.jsdelivr.net/${base}`,
    `https://github.com/${owner}/${name}/raw/${branch}/package.json`,
  ]
}

/** The version the repository publishes on the branch this machine follows. */
async function remoteVersion(repo, deps) {
  const fetchText = deps.fetchText ?? defaultFetchText
  const urls = deps.manifestUrls ? deps.manifestUrls(repo) : manifestUrls(repo)
  const failures = []
  for (const url of urls) {
    let text
    try {
      text = await fetchText(url)
    } catch (error) {
      failures.push(`${new URL(url).host}: ${error?.message ?? String(error)}`)
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch {
      failures.push(`${new URL(url).host}: the response was not JSON`)
      continue
    }
    const version = typeof manifest?.version === 'string' ? manifest.version : ''
    if (version) return version
    failures.push(`${new URL(url).host}: the manifest publishes no version`)
  }
  throw new SyncError(
    'E_UPDATE_REMOTE',
    `cannot read the version of ${repo.owner}/${repo.repo} (tried ${urls.length} sources: ${failures.join('; ')})`,
  )
}

/** The commit `refs/heads/<branch>` points at, as a full SHA. */
export async function resolveCommit(repo, deps = {}) {
  const runGit = deps.runGit ?? defaultRunGit
  const url = `https://github.com/${repo.owner}/${repo.repo}.git`
  const output = await runGit(['ls-remote', url, `refs/heads/${repo.branch}`])
  const first = String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const sha = first ? first.split(/\s+/)[0] : ''
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new SyncError('E_UPDATE_GIT', `cannot resolve ${repo.branch} in ${repo.owner}/${repo.repo}`)
  }
  return sha.toLowerCase()
}

function unsupportedReason(reason) {
  if (reason === 'local-install') return 'the plugin is installed from a local path, so the card cannot update it'
  if (reason === 'not-github') return 'the plugin is not installed from GitHub, so the card cannot check for updates'
  if (reason === 'no-manager') return 'this DSH host exposes no plugin manager, so the card cannot update the plugin'
  return 'this installation cannot be updated from the card'
}

/**
 * Read the installed version and, when this machine installed the plugin from
 * GitHub, the version that repository publishes today. Read-only: it never
 * touches the profile, so the card can call it on every mount.
 */
export async function checkUpdate(config, deps = {}) {
  const current = deps.currentVersion ?? (await ownPackageVersion())
  let spec = ''
  try {
    spec = (await (deps.installedSpec ?? installedSpec)(config)).spec
  } catch (error) {
    return { ok: true, supported: false, current, reason: 'no-manifest', detail: error?.message ?? String(error) }
  }
  if (!spec) return { ok: true, supported: false, current, reason: 'no-source' }
  const repo = (deps.parseSource ?? parseGitHubSource)(spec)
  if (!repo) {
    const local = /^(?:file|link):/i.test(spec) || /^[.~/\\]/.test(spec) || /^[a-z]:[\\/]/i.test(spec)
    return { ok: true, supported: false, current, source: spec, reason: local ? 'local-install' : 'not-github' }
  }
  const checked = {
    ok: true,
    supported: true,
    current,
    source: spec,
    repo: `${repo.owner}/${repo.repo}`,
    branch: repo.branch,
    // A copy pinned to a commit can be replaced by the manager with rollback;
    // a branch or tarball copy is installed over instead.
    mode: repo.commit ? 'update' : 'install',
  }
  try {
    const latest = await (deps.remoteVersion ?? remoteVersion)(repo, deps)
    return { ...checked, latest, available: compareVersions(latest, current) > 0 }
  } catch (error) {
    return { ...checked, latest: null, available: false, error: error?.message ?? String(error) }
  }
}

function installOutcome(result) {
  const application = String(result?.result?.application ?? result?.application ?? '')
  const failure = result?.result?.error ?? result?.error ?? null
  const ok = failure === null && (application === 'applied' || application === 'restart-required')
  const message = failure
    ? String(failure.diagnostic ?? failure.code ?? 'the update failed')
    : ok
      ? ''
      : 'the plugin manager did not apply the update'
  return { ok, application, message }
}

/**
 * Replace the running plugin with the version the repository publishes now.
 * The manager unloads this version, installs the pinned commit and rolls the
 * previous copy back when the installation fails, so the card can report a
 * failed update without leaving the profile uninstalled.
 */
export async function runUpdate(config, manager, target) {
  const startedAt = target.startedAt
  try {
    const result = target.mode === 'update' && typeof manager.updateBundle === 'function'
      ? await manager.updateBundle(PACKAGE_NAME, target.to, { spec: target.spec })
      : await manager.installBundle(target.spec, { expected: { name: PACKAGE_NAME, version: target.to } })
    const outcome = installOutcome(result)
    await writeUpdateState(config, {
      status: outcome.ok ? 'done' : 'failed',
      from: target.from,
      to: target.to,
      spec: target.spec,
      startedAt,
      finishedAt: new Date().toISOString(),
      application: outcome.application,
      message: outcome.message,
    })
    return outcome
  } catch (error) {
    await writeUpdateState(config, {
      status: 'failed',
      from: target.from,
      to: target.to,
      spec: target.spec,
      startedAt,
      finishedAt: new Date().toISOString(),
      application: '',
      message: error?.message ?? String(error),
    })
    return { ok: false, application: '', message: error?.message ?? String(error) }
  }
}

/**
 * Check, then hand the installation to the plugin manager. The install runs
 * after this response is sent because it unloads the plugin serving it: the
 * card polls the state file instead of waiting on a request that dies with the
 * old instance.
 */
export async function startUpdate(config, deps = {}) {
  let manager = deps.getManager ? deps.getManager() : undefined
  // A lazy service is often absent on a first synchronous read; let the caller
  // start it and ask again before giving up on this host.
  if ((!manager || typeof manager.installBundle !== 'function') && typeof deps.ensureManager === 'function') {
    manager = await deps.ensureManager()
  }
  if (!manager || typeof manager.installBundle !== 'function') {
    throw new SyncError('E_UPDATE_UNSUPPORTED', unsupportedReason('no-manager'))
  }
  const state = await checkUpdate(config, deps)
  if (!state.supported) {
    throw new SyncError('E_UPDATE_UNSUPPORTED', state.detail ?? unsupportedReason(state.reason))
  }
  if (state.error) throw new SyncError('E_UPDATE_CHECK', state.error)
  if (!state.available) throw new SyncError('E_UPDATE_CURRENT', `already on the newest version (${state.current})`)
  const repo = (deps.parseSource ?? parseGitHubSource)(state.source)
  const sha = await (deps.resolveCommit ?? resolveCommit)(repo, deps)
  const spec = `github:${repo.owner}/${repo.repo}#${sha}`
  const startedAt = new Date().toISOString()
  await writeUpdateState(config, {
    status: 'running',
    from: state.current,
    to: state.latest,
    spec,
    startedAt,
    finishedAt: null,
    application: '',
    message: '',
  })
  const target = { spec, from: state.current, to: state.latest, mode: state.mode, startedAt }
  const settled = deps.immediate === true
    ? runUpdate(config, manager, target)
    : new Promise((resolve) => {
        // Let the 202 response leave first: the installation unloads the plugin
        // whose request is being answered.
        setTimeout(() => { resolve(runUpdate(config, manager, target)) }, 250)
      })
  settled.catch(() => {})
  return { from: state.current, to: state.latest, spec, settled }
}
