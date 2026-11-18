import { join } from 'node:path'
import { readJson, writeFileAtomic } from './paths.js'
import { resolveDshHome } from './config.js'

export const ACTIVITY_VERSION = 1
export const ACTIVITY_FILE = 'activity.json'

export function activityPath(dshHome) {
  return join(dshHome, 'config-sync', ACTIVITY_FILE)
}

/**
 * Read the last activity record: what operation ran, when it started and
 * finished, and its outcome text. The card uses this on remount to restore a
 * consistent view of what happened while the page was closed (syncup's
 * "cached=1" equivalent). A missing or corrupt record reads as null.
 */
export async function readActivity(config) {
  try {
    const raw = await readJson(activityPath(resolveDshHome(config)))
    if (raw?.schemaVersion !== ACTIVITY_VERSION || typeof raw !== 'object') return null
    return {
      action: typeof raw.action === 'string' ? raw.action : '',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
      ok: raw.ok === true,
      text: typeof raw.text === 'string' ? raw.text : '',
    }
  } catch {
    return null
  }
}

/**
 * Persist the outcome of one sync operation. `writeStart` records that an
 * operation is in flight (the crash marker); `writeFinish` replaces it with
 * the result. Failures to persist activity are ignored: it is a UI aid, never
 * a sync primitive.
 */
export async function writeStart(config, action) {
  try {
    await writeFileAtomic(activityPath(resolveDshHome(config)), JSON.stringify({
      schemaVersion: ACTIVITY_VERSION,
      action,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: null,
      text: '',
    }))
  } catch {}
}

export async function writeFinish(config, action, ok, text) {
  try {
    await writeFileAtomic(activityPath(resolveDshHome(config)), JSON.stringify({
      schemaVersion: ACTIVITY_VERSION,
      action,
      startedAt: null,
      finishedAt: new Date().toISOString(),
      ok,
      text: String(text ?? '').slice(0, 8000),
    }))
  } catch {}
}
