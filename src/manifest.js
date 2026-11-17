import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SyncError } from './errors.js'
import { sha256 } from './paths.js'
import { sanitizeText } from './text.js'

export const MANIFEST_NAME = 'manifest.json'
export const BASE_FILES = ['package.json', 'cordis.patch.yml']
export const WORKSPACE_FILE = 'pnpm-workspace.yaml'
export const LOCKFILE = 'pnpm-lock.yaml'
export const MANIFEST_SCHEMA = 1

const LINK_PROTOCOLS = ['link:', 'file:', 'portal:', 'workspace:']
const SHA256 = /^[0-9a-f]{64}$/i

/** Manifest location inside the repository. One profile per directory. */
export function manifestPath(profile) {
  return `profiles/${profile}/${MANIFEST_NAME}`
}

/** Files this plugin is allowed to read or write, relative to the profile dir. */
export function allowedFiles(includeLockfile, includeWorkspace = false) {
  const files = [...BASE_FILES]
  if (includeWorkspace) files.push(WORKSPACE_FILE)
  if (includeLockfile) files.push(LOCKFILE)
  return files
}

export async function readLocalFiles(profileDir, profile, includeLockfile, includeWorkspace = false) {
  const files = new Map()
  for (const name of allowedFiles(includeLockfile, includeWorkspace)) {
    try {
      const data = await readFile(join(profileDir, name))
      files.set(`profiles/${profile}/${name}`, data)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return files
}

/** Push cannot invent a profile; status and pull may recover a missing one. */
export function requirePackageJson(files, profileDir) {
  if (![...files.keys()].some((path) => path.endsWith('/package.json'))) {
    throw new SyncError('E_PROFILE', `missing package.json in ${profileDir}`)
  }
}

export function buildManifest({ profile, files, dshVersion = null, device = null, generatedAt = new Date() }) {
  const parsed = parsePackageJson(files)
  const fileEntries = {}
  for (const [path, data] of files) {
    fileEntries[path] = { sha256: sha256(data), size: data.byteLength }
  }
  return {
    schemaVersion: MANIFEST_SCHEMA,
    kind: 'dsh-config-git-sync',
    generatedAt: generatedAt.toISOString(),
    profile,
    dshVersion,
    device,
    files: fileEntries,
    plugins: {
      bundles: parsed.bundles,
      dependencies: parsed.dependencies,
    },
  }
}

export function parsePackageJson(files) {
  const entry = [...files.entries()].find(([path]) => path.endsWith('/package.json'))
  if (!entry) return { bundles: [], dependencies: {} }
  let pkg
  try {
    pkg = JSON.parse(entry[1].toString('utf8'))
  } catch (error) {
    throw new SyncError('E_MANIFEST', `invalid package.json: ${error.message}`)
  }
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : []
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? { ...pkg.dependencies } : {}
  return { bundles, dependencies }
}

export function parseManifest(data) {
  let parsed
  try {
    parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
  } catch (error) {
    throw new SyncError('E_MANIFEST', `remote manifest.json is not valid JSON: ${error.message}`)
  }
  if (parsed?.schemaVersion !== MANIFEST_SCHEMA) {
    throw new SyncError(
      'E_MANIFEST',
      `unsupported manifest schemaVersion ${String(parsed?.schemaVersion)} (expected ${MANIFEST_SCHEMA})`,
    )
  }
  if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    throw new SyncError('E_MANIFEST', 'remote manifest.json has no files table')
  }
  for (const [path, entry] of Object.entries(parsed.files)) {
    if (!entry || typeof entry !== 'object' || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      throw new SyncError(
        'E_MANIFEST',
        `remote manifest.json has an invalid entry for ${sanitizeText(path, 160)}`,
      )
    }
    if (entry.size !== undefined && (!Number.isInteger(entry.size) || entry.size < 0)) {
      throw new SyncError(
        'E_MANIFEST',
        `remote manifest.json has an invalid size for ${sanitizeText(path, 160)}`,
      )
    }
  }
  return parsed
}

/**
 * Reject anything outside this profile's allowlist. Remote repositories are
 * untrusted input even when the user owns them.
 */
export function validateSyncPath(path, profile, includeLockfile, includeWorkspace = false) {
  const normalized = String(path).replace(/\\/g, '/')
  if (normalized.includes('\0') || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new SyncError('E_PATH', `refusing unsafe path: ${sanitizeText(path, 160)}`)
  }
  const prefix = `profiles/${profile}/`
  if (!normalized.startsWith(prefix)) {
    throw new SyncError(
      'E_PATH',
      `path is outside profiles/${sanitizeText(profile, 80)}: ${sanitizeText(path, 160)}`,
    )
  }
  const name = normalized.slice(prefix.length)
  if (!allowedFiles(includeLockfile, includeWorkspace).includes(name)) {
    throw new SyncError('E_PATH', `file is not syncable: ${sanitizeText(path, 160)}`)
  }
  return normalized
}

/**
 * Compare two file-hash tables, optionally restricted to the currently managed
 * paths. Entries may be plain SHA-256 strings (state) or manifest entries.
 */
export function changedFiles(previous, current, managed = null) {
  const before = previous ?? {}
  const after = current ?? {}
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed = []
  for (const path of [...paths].sort()) {
    if (managed && !managed.has(path)) continue
    const left = typeof before[path] === 'string' ? before[path] : before[path]?.sha256
    const right = typeof after[path] === 'string' ? after[path] : after[path]?.sha256
    if (left !== right) changed.push(path)
  }
  return changed
}

export function dependencyVersion(spec) {
  const text = String(spec ?? '').trim()
  if (!text) return 'unknown'
  if (LINK_PROTOCOLS.some((prefix) => text.startsWith(prefix))) return text
  return text
}

function canonicalFiles(files) {
  return Object.keys(files ?? {})
    .sort()
    .map((path) => `${path}:${files[path]?.sha256}:${files[path]?.size}`)
    .join('\n')
}

function canonicalPlugins(plugins) {
  const dependencies = Object.entries(plugins?.dependencies ?? {})
    .map(([name, spec]) => [name, String(spec)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const bundles = [...(plugins?.bundles ?? [])].map(String).sort()
  return JSON.stringify({ bundles, dependencies })
}

/**
 * Compare the parts that matter for syncing, ignoring metadata that changes on
 * every run (generatedAt, device, dshVersion). Used to keep pushes idempotent.
 */
export function sameSyncContent(a, b) {
  return (
    canonicalFiles(a?.files) === canonicalFiles(b?.files) &&
    canonicalPlugins(a?.plugins) === canonicalPlugins(b?.plugins)
  )
}

function pluginMap(manifest) {
  const map = new Map()
  const dependencies = manifest?.plugins?.dependencies ?? {}
  for (const [name, spec] of Object.entries(dependencies)) map.set(name, dependencyVersion(spec))
  const bundles = Array.isArray(manifest?.plugins?.bundles) ? manifest.plugins.bundles : []
  for (const name of bundles) if (!map.has(name)) map.set(name, 'bundle')
  return map
}

export function diffManifests(localManifest, remoteManifest) {
  const localFiles = localManifest?.files ?? {}
  const remoteFiles = remoteManifest?.files ?? {}
  const fileChanges = []
  const paths = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)])
  for (const path of [...paths].sort()) {
    const local = localFiles[path]
    const remote = remoteFiles[path]
    if (!local && remote) fileChanges.push({ path, status: 'added', remote })
    else if (local && !remote) fileChanges.push({ path, status: 'removed', local })
    else if (local.sha256 !== remote.sha256) fileChanges.push({ path, status: 'modified', local, remote })
  }

  const localPlugins = pluginMap(localManifest)
  const remotePlugins = pluginMap(remoteManifest)
  const added = []
  const removed = []
  const changed = []
  for (const [name, version] of remotePlugins) {
    if (!localPlugins.has(name)) added.push({ name, version })
    else if (localPlugins.get(name) !== version) {
      changed.push({ name, from: localPlugins.get(name), to: version })
    }
  }
  for (const [name, version] of localPlugins) {
    if (!remotePlugins.has(name)) removed.push({ name, version })
  }

  const manual = changed
    .concat(added)
    .filter((item) => LINK_PROTOCOLS.some((prefix) => String(item.version ?? item.to).startsWith(prefix)))
    .map((item) => item.name)

  return {
    fileChanges,
    plugins: { added, removed, changed, manual },
    hasChanges: fileChanges.length > 0 || added.length > 0 || removed.length > 0 || changed.length > 0,
  }
}

export function summarizeDiff(diff) {
  if (!diff?.hasChanges) return 'No differences between the local profile and the remote.'
  const lines = []
  const changed = diff.fileChanges.filter((item) => item.status !== 'unchanged')
  if (changed.length > 0) {
    lines.push('Files:')
    for (const item of changed) lines.push(`  ${item.status.padEnd(8)} ${sanitizeText(item.path, 200)}`)
  }
  const { added, removed, changed: versionChanged, manual } = diff.plugins
  if (added.length > 0) {
    lines.push(
      `Plugins to add: ${added
        .map((item) => `${sanitizeText(item.name, 120)}@${sanitizeText(item.version, 80)}`)
        .join(', ')}`,
    )
  }
  if (removed.length > 0) {
    lines.push(`Plugins to remove: ${removed.map((item) => sanitizeText(item.name, 120)).join(', ')}`)
  }
  if (versionChanged.length > 0) {
    lines.push(
      `Plugins to change: ${versionChanged
        .map(
          (item) =>
            `${sanitizeText(item.name, 120)} ${sanitizeText(item.from, 80)} -> ${sanitizeText(item.to, 80)}`,
        )
        .join(', ')}`,
    )
  }
  if (manual.length > 0) {
    lines.push(`Needs manual install (link/file specs): ${manual.map((name) => sanitizeText(name, 120)).join(', ')}`)
  }
  return lines.join('\n')
}
