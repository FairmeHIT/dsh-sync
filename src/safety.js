import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SyncError } from './errors.js'
import { allowedFiles, validateSyncPath } from './manifest.js'
import { sanitizeText } from './text.js'

/** Files the plugin may ever delete from a profile directory. */
export const DELETABLE = new Set(allowedFiles(true, true))

/**
 * Directory names that must survive every operation this plugin runs. The
 * profile directory is user data the plugin does not own; the package
 * manager, the Harness host and the user all keep files there.
 */
export const PROTECTED_ENTRIES = new Set([
  '.plugin-manager',
  'node_modules',
  '.dsh-module-fallback',
  'cordis.yml',
  'lock',
])

/**
 * Guard every local deletion this plugin performs. Even though the call
 * sites build names from the allowlist, a bug (or a future refactor) must
 * never widen the blast radius to an arbitrary path.
 */
export function assertDeletable(name) {
  if (DELETABLE.has(name)) return name
  throw new SyncError(
    'E_DELETE_REFUSED',
    `refusing to delete "${sanitizeText(name, 160)}": not a managed file. Report this as a bug; nothing was deleted.`,
  )
}

/**
 * A delete loop that cannot be talked into removing anything outside the
 * managed file set: each name is validated before the callback runs.
 */
export async function deleteManagedOnly(names, remove) {
  const done = []
  for (const name of names) {
    done.push(assertDeletable(name))
    await remove(name)
  }
  return done
}

/**
 * Refuse to run a package manager inside a profile directory that lost its
 * manifest. pnpm without a package.json reports ERR_PNPM_NO_PKG_MANIFEST and
 * a workspace without projects prunes node_modules; both are recoverable
 * only from a backup, so the guard turns them into a hard stop.
 */
export async function assertProfileWritable(profileDir) {
  let info
  try {
    info = await stat(join(profileDir, 'package.json'))
    if (!info.isFile()) throw new Error('not a regular file')
  } catch (error) {
    throw new SyncError(
      'E_PROFILE_EMPTY',
      `refusing to touch the profile: ${sanitizeText(profileDir, 200)} has no readable package.json. `
        + 'Restore it (for example from config-sync/snapshots) before pulling again.',
    )
  }
}

/**
 * Refuse a pull whose remote manifest carries no files. A healthy manifest
 * always references at least package.json; an empty one means an empty or
 * corrupt repository, and applying it would delete every managed file
 * locally while the local manifest might be the only good copy left.
 */
export function assertRemoteManifestPlausible(manifest, channel = '') {
  const files = manifest?.files && typeof manifest.files === 'object' ? Object.keys(manifest.files) : []
  if (files.length === 0) {
    throw new SyncError(
      'E_REMOTE_EMPTY_MANIFEST',
      `remote manifest for "${sanitizeText(channel || manifest?.profile || 'profile', 80)}" lists no files; `
        + 'refusing to apply it. Verify the remote repository, or push from a machine that still has the configuration.',
    )
  }
  const required = channel ? `profiles/${channel}/package.json` : null
  if (required && !files.includes(required)) {
    throw new SyncError(
      'E_REMOTE_EMPTY_MANIFEST',
      `remote manifest is missing ${sanitizeText(required, 160)}; refusing to apply it. `
        + 'Verify the remote repository before pulling.',
    )
  }
  for (const path of files) {
    // Re-run the syntactic checks with every include flag on: the local
    // include settings filter later, but nothing unsafe may pass at all.
    validateSyncPath(path, channel || manifest?.profile || 'profile', true, true)
  }
}

/**
 * Listing of a profile directory's top level, used to detect an unexpected
 * mass removal before the plugin is blamed for it (or causes one). Missing
 * directories list as empty; reading must never throw.
 */
export async function listProfileEntries(profileDir) {
  try {
    const entries = await readdir(profileDir, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
    }))
  } catch {
    return []
  }
}

/** `true` when the directory holds anything besides (at most) the managed files. */
export function hasUnmanagedContent(entries) {
  return entries.some((entry) => !DELETABLE.has(entry.name))
}

/**
 * Snapshot the managed files even when snapshotting is configured off: a
 * destructive pull (one that deletes a managed file) must always leave a
 * rollback copy behind.
 */
export function snapshotAlways(ctx, deletions, hasSnapshot) {
  if (hasSnapshot) return false
  if (!deletions || deletions.length === 0) return false
  return true
}

/**
 * Compare the before/after top-level listings of a profile directory after
 * the package manager ran. Returns the names of unmanaged entries that
 * disappeared and had not been expected to disappear.
 */
export function detectUnmanagedRemoval(before, after) {
  const gone = new Map(before.map((entry) => [entry.name, entry]))
  for (const entry of after) gone.delete(entry.name)
  return [...gone.keys()]
    .filter((name) => !DELETABLE.has(name))
    .sort()
}

/**
 * Names of managed files that this pull will delete locally: files the
 * machine previously synced and that the remote no longer carries.
 */
export function plannedDeletions({ allowedNames, syncedFiles, owned, channel }) {
  const prefix = `profiles/${channel}/`
  const out = []
  for (const name of allowedNames) {
    const path = `${prefix}${name}`
    if (syncedFiles.has(path)) continue
    if (owned.has(path)) out.push(name)
  }
  return out
}
