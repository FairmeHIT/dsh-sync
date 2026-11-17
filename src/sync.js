import { execFile } from 'node:child_process'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PACKAGE_NAME, requireBranch, requireRemote, resolveDshHome } from './config.js'
import { SyncError } from './errors.js'
import {
  commitManagedFiles,
  currentCommit,
  displayRemote,
  ensureWorkTree,
  headCommit,
  pushBranch,
  readBlob,
  treeEntries,
} from './git.js'
import { withLock } from './lock.js'
import {
  allowedFiles,
  buildManifest,
  changedFiles,
  diffManifests,
  manifestPath,
  parseManifest,
  readLocalFiles,
  requirePackageJson,
  sameSyncContent,
  summarizeDiff,
  validateSyncPath,
} from './manifest.js'
import {
  detectProfile,
  deviceId,
  deviceInfo,
  nowStamp,
  pathExists,
  readDshVersion,
  sha256,
  shortHash,
  writeFileAtomic,
} from './paths.js'
import { scanForSecrets, summarizeSecrets } from './secrets.js'
import { readState, writeState } from './state.js'
import { sanitizeText, summarizeList } from './text.js'

export { PACKAGE_NAME }

export async function resolveContext(config) {
  const branch = requireBranch(config)
  const dshHome = resolveDshHome(config)
  const profile = await detectProfile(dshHome, config.profile, PACKAGE_NAME)
  const profileDir = join(dshHome, 'profiles', profile)
  return { config: { ...config, branch }, dshHome, profile, profileDir }
}

function managedSet(config, profile) {
  const set = new Set()
  for (const name of allowedFiles(config.includeLockfile, config.includeWorkspace)) {
    set.add(`profiles/${profile}/${name}`)
  }
  return set
}

function shaMap(files) {
  const out = {}
  for (const [path, entry] of Object.entries(files ?? {})) out[path] = entry.sha256
  return out
}

async function localState(ctx, { requirePackage = false } = {}) {
  const files = await readLocalFiles(
    ctx.profileDir,
    ctx.profile,
    ctx.config.includeLockfile,
    ctx.config.includeWorkspace,
  )
  if (requirePackage) requirePackageJson(files, ctx.profileDir)
  const id = await deviceId(ctx.dshHome)
  const manifest = buildManifest({
    profile: ctx.profile,
    files,
    dshVersion: await readDshVersion(),
    device: deviceInfo(id),
  })
  return { files, manifest }
}

/**
 * Read the remote manifest and its managed files from Git objects, never from a
 * checked-out working tree. This makes hash verification independent of line
 * endings, Git attributes and symlinks.
 */
async function remoteState(ctx, work, { filter = true } = {}) {
  const rev = await currentCommit(ctx.config, work)
  if (!rev) return null
  const prefix = `profiles/${ctx.profile}/`
  const entries = await treeEntries(ctx.config, work, rev, prefix)
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const allAllowed = new Set([...allowedFiles(true, true), 'manifest.json'])
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue
    const name = entry.path.slice(prefix.length)
    if (!allAllowed.has(name)) {
      throw new SyncError(
        'E_PATH',
        `repository contains a path outside the allowlist: ${sanitizeText(entry.path, 160)}`,
      )
    }
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
      throw new SyncError(
        'E_PATH',
        `repository path is not a regular file: ${sanitizeText(entry.path, 160)}`,
      )
    }
  }

  const manifestEntry = byPath.get(manifestPath(ctx.profile))
  if (!manifestEntry) return null
  const raw = await readBlob(ctx.config, work, rev, manifestEntry.path)
  if (!raw) throw new SyncError('E_MANIFEST', 'remote manifest.json could not be read')
  const manifest = parseManifest(raw)
  if (manifest.profile !== ctx.profile) {
    throw new SyncError(
      'E_PROFILE_MISMATCH',
      `manifest says profile "${sanitizeText(manifest.profile, 80)}" but this machine syncs "${ctx.profile}"`,
    )
  }
  const required = `${prefix}package.json`
  if (!manifest.files[required]) {
    throw new SyncError('E_MANIFEST', `remote manifest is missing ${required}`)
  }

  const allowed = filter
    ? allowedFiles(ctx.config.includeLockfile, ctx.config.includeWorkspace)
    : allowedFiles(true, true)
  const files = new Map()
  const kept = {}
  for (const [path, entry] of Object.entries(manifest.files)) {
    // Syntactic validation always allows every managed file; the local
    // include settings then decide whether it participates in this sync.
    const safe = validateSyncPath(path, ctx.profile, true, true)
    const name = safe.slice(prefix.length)
    if (!allowed.includes(name)) continue
    const treeEntry = byPath.get(safe)
    if (!treeEntry) {
      throw new SyncError(
        'E_MANIFEST',
        `remote manifest references a missing file: ${sanitizeText(safe, 160)}`,
      )
    }
    if (treeEntry.type !== 'blob' || (treeEntry.mode !== '100644' && treeEntry.mode !== '100755')) {
      throw new SyncError(
        'E_MANIFEST',
        `remote path is not a regular file: ${sanitizeText(safe, 160)}`,
      )
    }
    const data = await readBlob(ctx.config, work, rev, safe)
    if (!data) {
      throw new SyncError('E_MANIFEST', `remote file could not be read: ${sanitizeText(safe, 160)}`)
    }
    if (entry.size !== undefined && data.byteLength !== entry.size) {
      throw new SyncError(
        'E_MANIFEST',
        `remote file size mismatch: ${sanitizeText(safe, 160)}. If another machine committed with core.autocrlf=true, line endings may have been rewritten; restore the file with core.autocrlf=false and push again.`,
      )
    }
    const digest = sha256(data)
    if (digest !== String(entry.sha256).toLowerCase()) {
      throw new SyncError(
        'E_MANIFEST',
        `remote file hash mismatch: ${sanitizeText(safe, 160)}. If another machine committed with core.autocrlf=true, line endings may have been rewritten; restore the file with core.autocrlf=false and push again.`,
      )
    }
    files.set(safe, data)
    kept[safe] = entry
  }
  return { manifest: { ...manifest, files: kept }, files, commit: rev }
}

function header(ctx) {
  return [
    `remote:  ${displayRemote(ctx.config.remote)}`,
    `branch:  ${ctx.config.branch}`,
    `profile: ${ctx.profile}`,
  ].join('\n')
}

function pluginCount(manifest) {
  const deps = Object.keys(manifest?.plugins?.dependencies ?? {}).length
  const bundles = manifest?.plugins?.bundles?.length ?? 0
  return Math.max(deps, bundles)
}

function listPaths(paths) {
  return summarizeList(paths.map((path) => path.replace(/^profiles\/[^/]+\//, '')))
}

async function recordState(config, profile, value) {
  try {
    await writeState(config, profile, value)
    return null
  } catch (error) {
    return `could not record the last-sync state: ${error.message}`
  }
}

export async function status(rawConfig, options = {}) {
  requireRemote(rawConfig)
  const ctx = await resolveContext(rawConfig)
  return withLock(ctx.dshHome, () => statusLocked(ctx, options), { signal: options.signal })
}

async function statusLocked(ctx, options) {
  const work = await ensureWorkTree(ctx.config, { signal: options.signal })
  const local = await localState(ctx)
  const remote = await remoteState(ctx, work)
  const state = await readState(ctx.config, ctx.profile)

  const lines = ['Config sync status', header(ctx)]
  if (remote === null) {
    lines.push('', 'Remote repository has no manifest yet.', 'Run /sync-push to publish this profile first.')
    return lines.join('\n')
  }

  const diff = diffManifests(local.manifest, remote.manifest)
  const head = await headCommit(ctx.config, work, options.signal)
  const managed = managedSet(ctx.config, ctx.profile)
  const remoteChanged = state ? changedFiles(state.files, shaMap(remote.manifest.files), managed) : null
  const localChanged = state ? changedFiles(state.files, shaMap(local.manifest.files), managed) : null
  lines.push(
    `remote commit: ${head ?? 'unknown'} (manifest ${sanitizeText(remote.manifest.generatedAt, 80)})`,
    `local files: ${local.files.size} | plugins: ${pluginCount(local.manifest)}`,
  )
  if (state) {
    const when = state.syncedAt ? ` at ${sanitizeText(state.syncedAt, 40)}` : ''
    lines.push(`last sync: ${state.direction} ${shortHash(state.commit)}${when}`)
    lines.push(
      `remote changed since last sync: ${
        remoteChanged.length > 0 ? `yes (${listPaths(remoteChanged)})` : 'no'
      }`,
    )
    if (localChanged.length > 0) {
      lines.push(`local changed since last sync: yes (${listPaths(localChanged)})`)
    }
  } else {
    lines.push('last sync: never on this machine')
  }
  lines.push('', summarizeDiff(diff))
  return lines.join('\n')
}

function commitMessage(ctx, local, message) {
  const typed = String(message ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, 500)
  if (typed) return typed
  const host = local.manifest.device?.host ?? 'unknown'
  return `sync(${ctx.profile}): ${new Date().toISOString()} from ${host}`
}

export async function push(rawConfig, options = {}) {
  requireRemote(rawConfig)
  const ctx = await resolveContext(rawConfig)
  return withLock(ctx.dshHome, () => pushLocked(ctx, options), { signal: options.signal })
}

async function pushLocked(ctx, options) {
  const work = await ensureWorkTree(ctx.config, { signal: options.signal })
  const local = await localState(ctx, { requirePackage: true })
  const remote = await remoteState(ctx, work, { filter: false })
  const state = await readState(ctx.config, ctx.profile)
  const managed = managedSet(ctx.config, ctx.profile)
  const owned = new Set(Object.keys(state?.files ?? {}))
  const compareSet = new Set([...managed, ...owned])

  if (remote !== null && sameSyncContent(local.manifest, remote.manifest)) {
    const warning = await recordState(ctx.config, ctx.profile, {
      commit: remote.commit,
      files: shaMap(local.manifest.files),
      direction: 'push',
    })
    return [
      'Config sync push',
      header(ctx),
      '',
      'Already up to date; nothing to commit.',
      warning ? `warning: ${warning}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (remote !== null && options.force !== true) {
    if (!state) {
      throw new SyncError(
        'E_CONFLICT',
        `remote already contains a manifest for profile "${ctx.profile}" and this machine has never synced; run /sync-pull first to adopt it, or push with force=true to overwrite it`,
      )
    }
    const remoteChanged = changedFiles(state.files, shaMap(remote.manifest.files), compareSet)
    if (remoteChanged.length > 0) {
      throw new SyncError(
        'E_CONFLICT',
        `remote changed since this machine's last sync (${listPaths(remoteChanged)}); run /sync-pull first, or push with force=true to overwrite it`,
      )
    }
  }

  // Preserve remote files this machine does not manage and has never owned.
  // Without this, a machine that leaves includeLockfile/includeWorkspace at
  // their defaults would silently delete another machine's optional files.
  const preserved = new Map()
  if (remote) {
    for (const [path, data] of remote.files) {
      if (local.files.has(path) || owned.has(path)) continue
      preserved.set(path, data)
    }
  }
  const manifest = { ...local.manifest, files: { ...local.manifest.files } }
  for (const [path, data] of preserved) {
    manifest.files[path] = { sha256: sha256(data), size: data.byteLength }
  }
  if (remote !== null && sameSyncContent(manifest, remote.manifest)) {
    const warning = await recordState(ctx.config, ctx.profile, {
      commit: remote.commit,
      files: shaMap(local.manifest.files),
      direction: 'push',
    })
    return [
      'Config sync push',
      header(ctx),
      '',
      'Already up to date; nothing to commit.',
      preserved.size > 0
        ? `preserved: ${listPaths([...preserved.keys()])} (not managed by this machine)`
        : '',
      warning ? `warning: ${warning}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  const findings = ctx.config.secretScan === 'warn' ? scanForSecrets(local.files) : []
  const prefix = `profiles/${ctx.profile}/`
  await rm(join(work, 'profiles', ctx.profile), { recursive: true, force: true })
  const committed = new Map()
  for (const [path, data] of local.files) {
    const safe = validateSyncPath(
      path,
      ctx.profile,
      ctx.config.includeLockfile,
      ctx.config.includeWorkspace,
    )
    await writeFileAtomic(join(work, safe), data)
    committed.set(safe, data)
  }
  for (const [path, data] of preserved) {
    const safe = validateSyncPath(path, ctx.profile, true, true)
    await writeFileAtomic(join(work, safe), data)
    committed.set(safe, data)
  }
  const manifestRel = manifestPath(ctx.profile)
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFileAtomic(join(work, manifestRel), manifestBytes)
  committed.set(manifestRel, manifestBytes)

  const message = commitMessage(ctx, local, options.message)
  const result = await commitManagedFiles(ctx.config, work, {
    profile: ctx.profile,
    files: committed,
    message,
    signal: options.signal,
  })

  if (!result.changed) {
    const warning = await recordState(ctx.config, ctx.profile, {
      commit: remote?.commit ?? result.commit,
      files: shaMap(local.manifest.files),
      direction: 'push',
    })
    return [
      'Config sync push',
      header(ctx),
      '',
      'Already up to date; nothing to commit.',
      warning ? `warning: ${warning}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  await pushBranch(ctx.config, work, { signal: options.signal })
  const warning = await recordState(ctx.config, ctx.profile, {
    commit: result.commit,
    files: shaMap(local.manifest.files),
    direction: 'push',
  })

  const lines = [
    'Config sync push',
    header(ctx),
    `files:   ${committed.size - 1}`,
    `plugins: ${pluginCount(local.manifest)}`,
    `commit:  ${shortHash(result.commit)}`,
  ]
  if (remote !== null && options.force === true) lines.push('mode:    forced overwrite of remote changes')
  if (preserved.size > 0) {
    lines.push(`preserved: ${listPaths([...preserved.keys()])} (not managed by this machine)`)
  }
  if (findings.length > 0) lines.push('', summarizeSecrets(findings))
  if (warning) lines.push('', `warning: ${warning}`)
  lines.push('', 'Pushed. Other machines can now run /sync-pull.')
  return lines.join('\n')
}

async function pruneSnapshots(root, keep) {
  if (!(keep > 0)) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const stale = dirs.slice(0, Math.max(0, dirs.length - keep))
  for (const name of stale) await rm(join(root, name), { recursive: true, force: true })
}

async function snapshotLocal(ctx, local) {
  if (!ctx.config.snapshot) return null
  const root = join(ctx.dshHome, 'config-sync', 'snapshots', ctx.profile)
  const base = nowStamp()
  let dir = join(root, base)
  for (let suffix = 1; await pathExists(dir); suffix += 1) dir = join(root, `${base}-${suffix}`)
  for (const [path, data] of local.files) {
    await writeFileAtomic(join(dir, path), data, { mode: 0o600 })
  }
  await writeFileAtomic(join(dir, manifestPath(ctx.profile)), `${JSON.stringify(local.manifest, null, 2)}\n`, {
    mode: 0o600,
  })
  await pruneSnapshots(root, ctx.config.snapshotKeep)
  return dir
}

async function restoreLocal(ctx, localFiles) {
  const prefix = `profiles/${ctx.profile}/`
  for (const name of allowedFiles(ctx.config.includeLockfile, ctx.config.includeWorkspace)) {
    if (!localFiles.has(`${prefix}${name}`)) await rm(join(ctx.profileDir, name), { force: true })
  }
  for (const [path, data] of localFiles) {
    await writeFileAtomic(join(ctx.profileDir, path.slice(prefix.length)), data)
  }
}

function tail(text, lines = 20) {
  const rows = String(text ?? '')
    .trim()
    .split(/\r?\n/)
  return rows.slice(Math.max(0, rows.length - lines)).join('\n')
}

export function packageManagerOrder({ pnpmLock = false, npmLock = false } = {}) {
  if (npmLock && !pnpmLock) return ['npm']
  return ['pnpm', 'corepack', 'npm']
}

function runCommand(command, args, cwd, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        signal: options.signal,
        // .cmd shims (pnpm/corepack on Windows) need a shell. Arguments here are
        // constants owned by this file, never user input.
        shell: process.platform === 'win32',
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          aborted: options.signal?.aborted === true || error?.name === 'AbortError',
          spawnCode: typeof error?.code === 'string' ? error.code : null,
          output: `${stdout ?? ''}\n${stderr ?? ''}`.trim(),
        })
      },
    )
  })
}

/** A real install error (missing link target, dependency conflict) is not a missing binary. */
export function isMissingCommand(result) {
  if (result.spawnCode === 'ENOENT') return true
  return /(?:is not recognized as an internal or external command|不是内部或外部命令|command not found)/i.test(
    result.output,
  )
}

export async function reconcilePackages(ctx, options = {}) {
  if (ctx.config.reconcile === 'none') return { ok: true, skipped: true, output: 'reconcile: none' }
  const managers = packageManagerOrder({
    pnpmLock: await pathExists(join(ctx.profileDir, 'pnpm-lock.yaml')),
    npmLock: await pathExists(join(ctx.profileDir, 'package-lock.json')),
  })
  const attempts = []
  for (const manager of managers) {
    if (manager === 'pnpm') attempts.push({ tool: 'pnpm', command: 'pnpm', args: ['install'] })
    else if (manager === 'corepack') {
      attempts.push({ tool: 'corepack pnpm', command: 'corepack', args: ['pnpm', 'install'] })
    } else if (manager === 'npm') {
      attempts.push({ tool: 'npm', command: 'npm', args: ['install', '--no-audit', '--no-fund'] })
    }
  }
  const failures = []
  for (const attempt of attempts) {
    const result = await runCommand(attempt.command, attempt.args, ctx.profileDir, {
      signal: options.signal,
    })
    if (result.ok) return { ok: true, tool: attempt.tool, output: result.output }
    if (result.aborted) throw new SyncError('E_CANCELLED', 'package install cancelled')
    const missing = isMissingCommand(result)
    failures.push({ tool: attempt.tool, missing, output: result.output })
    // A real install failure is reported; do not run another package manager
    // over a half-resolved profile.
    if (!missing) break
  }
  return {
    ok: false,
    output: failures.map((failure) => `${failure.tool}: ${tail(failure.output, 6)}`).join('\n'),
  }
}

export async function pull(rawConfig, options = {}) {
  requireRemote(rawConfig)
  const ctx = await resolveContext(rawConfig)
  return withLock(ctx.dshHome, () => pullLocked(ctx, options), { signal: options.signal })
}

async function pullLocked(ctx, options) {
  const work = await ensureWorkTree(ctx.config, { signal: options.signal })
  const local = await localState(ctx)
  const remote = await remoteState(ctx, work)

  if (remote === null) {
    throw new SyncError(
      'E_REMOTE_EMPTY',
      'remote repository has no manifest yet; push from the source machine first',
    )
  }

  const diff = diffManifests(local.manifest, remote.manifest)
  const state = await readState(ctx.config, ctx.profile)
  const managed = managedSet(ctx.config, ctx.profile)
  const localChanged = state ? changedFiles(state.files, shaMap(local.manifest.files), managed) : []

  if (!diff.hasChanges) {
    let warning = null
    if (options.apply === true) {
      warning = await recordState(ctx.config, ctx.profile, {
        commit: remote.commit,
        files: shaMap(remote.manifest.files),
        direction: 'pull',
      })
    }
    return [
      'Config sync pull',
      header(ctx),
      '',
      'Already up to date.',
      warning ? `warning: ${warning}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (options.apply !== true) {
    const lines = ['Config sync pull (dry run)', header(ctx), '', summarizeDiff(diff)]
    if (localChanged.length > 0) {
      lines.push(
        '',
        `local changes since last sync: ${listPaths(localChanged)}`,
        'Applying will overwrite them; a snapshot is written first.',
      )
    }
    lines.push('', 'Nothing written. Run /sync-pull apply to apply these files locally.')
    return lines.join('\n')
  }

  const snapshot = await snapshotLocal(ctx, local)
  const prefix = `profiles/${ctx.profile}/`
  const owned = new Set(Object.keys(state?.files ?? {}))
  const kept = []
  try {
    for (const [path, data] of remote.files) {
      const safe = validateSyncPath(
        path,
        ctx.profile,
        ctx.config.includeLockfile,
        ctx.config.includeWorkspace,
      )
      await writeFileAtomic(join(ctx.profileDir, safe.slice(prefix.length)), data)
    }
    for (const [path, data] of remote.files) {
      const safe = validateSyncPath(
        path,
        ctx.profile,
        ctx.config.includeLockfile,
        ctx.config.includeWorkspace,
      )
      const actual = await readFile(join(ctx.profileDir, safe.slice(prefix.length)))
      if (!actual.equals(data)) {
        throw new SyncError('E_APPLY', `written file does not match the remote: ${sanitizeText(safe, 160)}`)
      }
    }
    // Converge only files this machine previously synced. A local file the
    // remote never managed (for example a local cordis.patch.yml on a fresh
    // machine) is kept and reported instead of being deleted.
    for (const name of allowedFiles(ctx.config.includeLockfile, ctx.config.includeWorkspace)) {
      const path = `${prefix}${name}`
      if (remote.files.has(path)) continue
      if (owned.has(path)) await rm(join(ctx.profileDir, name), { force: true })
      else if (await pathExists(join(ctx.profileDir, name))) kept.push(name)
    }
  } catch (error) {
    let restoreNote = 'local files were restored'
    try {
      await restoreLocal(ctx, local.files)
    } catch (restoreError) {
      restoreNote = `restoring local files also failed: ${restoreError.message}`
    }
    throw new SyncError('E_APPLY', `failed to apply remote files; ${restoreNote} (${error.message})`)
  }

  const packageChanged =
    diff.fileChanges.some((item) => /(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(item.path)) ||
    diff.plugins.added.length > 0 ||
    diff.plugins.removed.length > 0 ||
    diff.plugins.changed.length > 0

  let install = null
  if (packageChanged) install = await reconcilePackages(ctx, { signal: options.signal })

  const warning = await recordState(ctx.config, ctx.profile, {
    commit: remote.commit,
    files: shaMap(remote.manifest.files),
    direction: 'pull',
  })

  const lines = [
    'Config sync pull',
    header(ctx),
    '',
    summarizeDiff(diff),
    '',
    `snapshot: ${snapshot ?? 'disabled'}`,
  ]
  if (localChanged.length > 0) {
    lines.push(`overwritten: local changes since last sync (${listPaths(localChanged)})`)
  }
  if (kept.length > 0) {
    lines.push(`kept locally: ${kept.join(', ')} (not previously synced by this machine)`)
  }
  if (install) {
    if (!install.ok) {
      lines.push('packages: automatic install failed; see output below', tail(install.output, 12))
    } else if (!install.skipped) {
      lines.push(`packages: installed with ${install.tool}`)
    }
  }
  if (diff.plugins.manual.length > 0) {
    lines.push(
      `manual: ${diff.plugins.manual.map((name) => sanitizeText(name, 120)).join(', ')} use link/file specs and must be restored by hand`,
    )
  }
  if (warning) lines.push(`warning: ${warning}`)
  lines.push('', 'Restart DeepSeek Harness so cordis.patch.yml and plugin changes take effect.')
  return lines.join('\n')
}
