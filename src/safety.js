import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SyncError } from './errors.js'
import { allowedFiles, parsePackageJson, validateSyncPath } from './manifest.js'
import { pathExists } from './paths.js'
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

/**
 * Move a managed file out of the profile instead of deleting it. The plugin
 * never destroys the only copy of anything: removals are parked in the
 * snapshot directory, so even a pull that was forced through can be undone by
 * copying the files back.
 */
const QUARANTINE_FALLBACK = new Set(['EXDEV', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST'])

export async function quarantineManagedFile(profileDir, quarantineDir, name) {
  const safe = assertDeletable(name)
  const from = join(profileDir, safe)
  if (!(await pathExists(from))) return false
  await mkdir(quarantineDir, { recursive: true })
  const to = join(quarantineDir, safe)
  try {
    await rename(from, to)
  } catch (error) {
    if (!QUARANTINE_FALLBACK.has(error?.code)) throw error
    await copyFile(from, to)
    await rm(from, { force: true })
  }
  return true
}

/** The two halves of a profile's plugin list, as the manifest records them. */
function pluginLists(manifest) {
  const plugins = manifest?.plugins
  return {
    bundles: Array.isArray(plugins?.bundles) ? plugins.bundles.map(String) : [],
    dependencies: Object.keys(plugins?.dependencies ?? {}).sort(),
  }
}

/**
 * What applying a remote manifest would remove compared with what this machine
 * has right now. Used both to warn in a preview and to refuse an apply.
 */
export function pullRisk(beforeManifest, afterManifest) {
  const before = pluginLists(beforeManifest)
  const after = pluginLists(afterManifest)
  const afterBundles = new Set(after.bundles)
  const afterDependencies = new Set(after.dependencies)
  const droppedBundles = before.bundles.filter((name) => !afterBundles.has(name))
  const droppedDependencies = before.dependencies.filter((name) => !afterDependencies.has(name))
  const beforeCount = before.bundles.length + before.dependencies.length
  const afterCount = after.bundles.length + after.dependencies.length
  const droppedCount = droppedBundles.length + droppedDependencies.length
  return {
    beforeCount,
    afterCount,
    droppedCount,
    droppedBundles,
    droppedDependencies,
    /** Nothing would be left to install: the profile loses every plugin. */
    emptiesProfile: beforeCount > 0 && afterCount === 0,
    /** More than half of the plugin list disappears in one pull. */
    removesHalf: beforeCount >= 5 && droppedCount * 2 >= beforeCount,
  }
}

export function isDestructivePull(risk) {
  return risk.emptiesProfile === true || risk.removesHalf === true
}

/** Bounded, sanitized list of what a destructive pull would drop. */
export function describeDropped(risk, limit = 8) {
  const names = [...risk.droppedDependencies, ...risk.droppedBundles].map((name) => sanitizeText(name, 80))
  if (names.length === 0) return 'no plugins'
  const head = names.slice(0, limit).join(', ')
  return names.length > limit ? `${head}, +${names.length - limit} more` : head
}

/**
 * Refuse a pull that would wipe the profile's plugins. This is the exact shape
 * of the 2026-11-20 incident: a remote manifest that looked readable but
 * carried no plugins, applied over a healthy profile. A remote is untrusted
 * input, and a profile that is emptied is only recoverable from a backup, so
 * the removal must be explicit (`force`) rather than accidental.
 */
export function assertPullSafe(beforeManifest, afterManifest, { force = false } = {}) {
  const risk = pullRisk(beforeManifest, afterManifest)
  if (!isDestructivePull(risk) || force === true) return risk
  const what = risk.emptiesProfile
    ? 'it would remove every plugin from this profile'
    : `it would remove ${risk.droppedCount} of ${risk.beforeCount} plugins`
  throw new SyncError(
    'E_DESTRUCTIVE_PULL',
    `refusing the pull: ${what} (${describeDropped(risk)}). `
      + 'The remote branch may be empty, stale or from a fresh profile. '
      + 'Write this machine\'s configuration first (/sync-push), or re-run with force to accept the removal.',
    { risk },
  )
}

/**
 * A package manager must never run with a manifest that lost most of its
 * dependencies: `pnpm install` prunes node_modules down to whatever the new
 * manifest declares, so an emptied package.json silently uninstalls every
 * plugin. Returns null when installing is safe.
 */
export function installRisk(beforeManifest, afterManifest) {
  const before = pluginLists(beforeManifest)
  const after = pluginLists(afterManifest)
  if (before.dependencies.length === 0) return null
  const afterDependencies = new Set(after.dependencies)
  const dropped = before.dependencies.filter((name) => !afterDependencies.has(name))
  if (after.dependencies.length === 0) {
    return {
      code: 'E_INSTALL_EMPTY',
      message: 'the new manifest declares no plugins; automatic install skipped so node_modules is not pruned',
      dependencies: dropped,
    }
  }
  if (before.dependencies.length >= 5 && dropped.length * 2 >= before.dependencies.length) {
    return {
      code: 'E_INSTALL_SHRINK',
      message: `the new manifest drops ${dropped.length} of ${before.dependencies.length} dependencies; automatic install skipped so node_modules is not pruned`,
      dependencies: dropped,
    }
  }
  return null
}

/**
 * Dependencies the manifest declares but node_modules does not contain. A
 * profile that lost packages looks installed until the next restart fails, so
 * the pull reports them instead of claiming success.
 */
export async function missingDependencies(profileDir, manifest) {
  const { dependencies } = pluginLists(manifest)
  const missing = []
  for (const name of dependencies) {
    const segments = name.split('/')
    if (!(await pathExists(join(profileDir, 'node_modules', ...segments)))) missing.push(name)
  }
  return missing
}

/**
 * The manifest's plugin table must agree with the package.json it ships.
 * A manifest that claims dependencies its package.json does not declare (or
 * the other way round) is corrupt; applying it would delete or mis-install.
 */
export function assertManifestPlugins(manifest, files, channel) {
  const prefix = `profiles/${channel}/`
  if (!files.has(`${prefix}package.json`)) return
  const parsed = parsePackageJson(files)
  const declared = pluginLists(manifest)
  const sameBundles =
    parsed.bundles.length === declared.bundles.length
    && parsed.bundles.every((name) => declared.bundles.includes(name))
  const parsedDependencies = Object.keys(parsed.dependencies).sort()
  const sameDependencies =
    parsedDependencies.length === declared.dependencies.length
    && parsedDependencies.every((name, index) => name === declared.dependencies[index])
  if (sameBundles && sameDependencies) return
  throw new SyncError(
    'E_MANIFEST_CONFLICT',
    `remote manifest.json disagrees with ${prefix}package.json about the installed plugins; refusing to apply it. `
      + 'Push again from a machine whose profile is intact, or repair manifest.json by hand.',
  )
}
