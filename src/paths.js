import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SyncError } from './errors.js'

export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
}

export async function readText(path) {
  return readFile(path, 'utf8')
}

export async function readJson(path) {
  return JSON.parse(await readText(path))
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Write through a temporary file so a crash cannot leave a half-written config.
 * Windows antivirus and indexers can briefly lock the destination; retry those
 * transient failures instead of reporting a corrupt sync state.
 */
export async function writeFileAtomic(path, data, options = {}) {
  await ensureDir(dirname(path))
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, data, options.mode ? { mode: options.mode } : undefined)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, path)
      return
    } catch (error) {
      if (!RETRYABLE_RENAME.has(error?.code) || attempt >= 4) {
        await rm(tmp, { force: true })
        throw error
      }
      await delay(20 * (attempt + 1))
    }
  }
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function shortHash(value, length = 12) {
  return String(value ?? '').slice(0, length)
}

/** Profile names become path segments and repository directories. */
export function isValidProfileName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name))
}

/** Stable per-machine id; never leaves the machine except as an informational field. */
export async function deviceId(dshHome) {
  const file = join(dshHome, 'config-sync', 'device.json')
  try {
    const parsed = JSON.parse(await readText(file))
    if (typeof parsed.id === 'string' && parsed.id.length > 0) return parsed.id
  } catch {}
  const id = randomUUID()
  await writeFileAtomic(file, `${JSON.stringify({ id }, null, 2)}\n`, { mode: 0o600 })
  return id
}

export function deviceInfo(id) {
  return {
    id,
    host: hostname(),
    platform: platform(),
  }
}

/**
 * Version of the running Harness, used as provenance in the manifest. Desktop
 * exposes DSH_INSTALL_DIR; tests and source launches may expose DSH_VERSION.
 */
export async function readDshVersion() {
  const fromEnv = String(process.env.DSH_VERSION || '').trim()
  if (fromEnv) return fromEnv
  const install = String(process.env.DSH_INSTALL_DIR || '').trim()
  if (!install) return null
  try {
    const pkg = await readJson(join(install, 'package.json'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

export async function listProfiles(dshHome) {
  try {
    const entries = await readdir(join(dshHome, 'profiles'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Pick the profile that actually references this plugin. Running from a linked
 * checkout means the plugin directory is not inside the profile, so the
 * profile manifest is the reliable signal.
 */
export async function detectProfile(dshHome, preferred, packageName) {
  if (preferred) {
    if (!isValidProfileName(preferred)) {
      throw new SyncError('E_PROFILE', `invalid profile name: ${preferred}`)
    }
    return preferred
  }
  const profiles = await listProfiles(dshHome)
  const matches = []
  for (const name of profiles) {
    try {
      const pkg = JSON.parse(await readText(join(dshHome, 'profiles', name, 'package.json')))
      const bundles = pkg?.dsh?.profile?.bundles
      const deps = pkg?.dependencies ?? {}
      if (Array.isArray(bundles) && bundles.includes(packageName)) matches.push(name)
      else if (Object.hasOwn(deps, packageName)) matches.push(name)
    } catch {}
  }
  if (matches.length === 1) return validDetected(matches[0])
  if (matches.includes('desktop')) return 'desktop'
  if (matches.includes('web')) return 'web'
  if (profiles.length === 1) return validDetected(profiles[0])
  const found = matches.length > 0 ? ` (matches: ${matches.join(', ')})` : ''
  throw new SyncError(
    'E_PROFILE',
    `cannot detect a profile${found}; set config.profile explicitly (available: ${profiles.join(', ') || 'none'})`,
  )
}

function validDetected(name) {
  if (!isValidProfileName(name)) {
    throw new SyncError(
      'E_PROFILE',
      `detected profile name is not a safe path segment: ${JSON.stringify(name)}; set config.profile explicitly`,
    )
  }
  return name
}
