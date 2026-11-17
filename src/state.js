import { join } from 'node:path'
import { readJson, writeFileAtomic, ensureDir } from './paths.js'
import { resolveDshHome } from './config.js'

export const STATE_VERSION = 1
export const STATE_FILE = 'state.json'

/** Per-profile record of the last successful push or pull. */
export function statePath(dshHome) {
  return join(dshHome, 'config-sync', STATE_FILE)
}

function validEntry(entry, config) {
  return (
    entry &&
    typeof entry === 'object' &&
    entry.remote === config.remote &&
    entry.branch === String(config.branch || 'main').trim() &&
    typeof entry.commit === 'string' &&
    entry.commit.length > 0 &&
    typeof entry.files === 'object' &&
    entry.files !== null
  )
}

/**
 * Read this machine's last-sync record for one profile. A missing, corrupt or
 * mismatched record is treated as "never synced" rather than a hard failure:
 * that makes push conservative and lets the user recover by pulling or forcing.
 */
export async function readState(config, profile) {
  let raw
  try {
    raw = await readJson(statePath(resolveDshHome(config)))
  } catch {
    return null
  }
  if (raw?.schemaVersion !== STATE_VERSION || typeof raw.profiles !== 'object' || !raw.profiles) {
    return null
  }
  const entry = raw.profiles[profile]
  if (!validEntry(entry, config)) return null
  const files = {}
  for (const [path, value] of Object.entries(entry.files)) {
    if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) files[path] = value.toLowerCase()
  }
  return {
    profile,
    remote: entry.remote,
    branch: entry.branch,
    commit: entry.commit,
    direction: entry.direction === 'pull' ? 'pull' : 'push',
    syncedAt: typeof entry.syncedAt === 'string' ? entry.syncedAt : null,
    files,
  }
}

/**
 * Persist the last-sync record after a successful push or pull. Other profiles
 * in the same Harness home are preserved.
 */
export async function writeState(config, profile, { commit, files, direction }) {
  const dshHome = resolveDshHome(config)
  const file = statePath(dshHome)
  let raw = null
  try {
    raw = await readJson(file)
  } catch {}
  const profiles =
    raw?.schemaVersion === STATE_VERSION && raw.profiles && typeof raw.profiles === 'object'
      ? { ...raw.profiles }
      : {}
  profiles[profile] = {
    remote: config.remote,
    branch: String(config.branch || 'main').trim(),
    commit,
    direction: direction === 'pull' ? 'pull' : 'push',
    syncedAt: new Date().toISOString(),
    files: { ...files },
  }
  await ensureDir(join(dshHome, 'config-sync'))
  await writeFileAtomic(file, `${JSON.stringify({ schemaVersion: STATE_VERSION, profiles }, null, 2)}\n`, {
    mode: 0o600,
  })
}
