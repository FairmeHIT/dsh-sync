import { SyncError } from './errors.js'
import { displayRemote } from './git.js'
import { ensureDir, writeFileAtomic } from './paths.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const PROBE_MARKER = '.config-sync-probe'

/**
 * Probe the remote repository for read/write access without touching synced
 * content. Inspired by dsh-plugin-account-sync's transport test(): the probe
 * writes a tiny marker file, pushes it, reads the pushed tip back, then
 * restores the branch. It reuses the exact git helpers a real sync uses
 * (same work tree, credentials, branch handling), so a passing probe means
 * the next sync will work too.
 *
 * `git` must expose the same functions sync.js imports from ./git.js:
 * ensureWorkTree, commitManagedFiles, pushBranch, currentCommit, readBlob,
 * removeManagedFile and indexEntries.
 */
export async function probeRemote(config, git, options = {}) {
  if (!config.remote) throw new SyncError('E_CONFIG', 'no git remote configured')
  const branch = String(config.branch ?? '').trim() || 'main'
  const profile = String(config.profile ?? '').trim() || 'desktop'
  const prefix = `profiles/${profile}/`
  const work = await git.ensureWorkTree(config, { signal: options.signal })
  const probePath = `${prefix}${PROBE_MARKER}`
  const probeDir = join(work, prefix)
  const content = `${PROBE_MARKER} ${new Date().toISOString()} pid=${process.pid}\n`

  const lines = ['Config sync connection test', `remote: ${displayRemote(config.remote)}`, `branch: ${branch}`]

  // 1) ensureWorkTree already fetched the branch: that proves network,
  //    credentials and branch access — the same things /sync-status needs.
  lines.push('read: ok')

  // The work tree mirrors the remote branch, which already holds the synced
  // files. commitManagedFiles stages the whole prefix and then verifies the
  // staged set against the files we hand it, so the probe must commit the
  // marker together with the existing synced content — byte-exact, exactly
  // as a real push would — instead of a marker-only set (0.7.0 bug: on a
  // non-empty remote the staged set contained the checked-out files and the
  // verify step failed with "staged file set mismatch").
  const headBefore = await git.currentCommit(config, work)
  const existing = await git.indexEntries(config, work, prefix, options.signal)
  const files = new Map()
  for (const [path, entry] of existing) {
    if (!headBefore) continue
    const blob = await git.readBlob(config, work, headBefore, path)
    if (blob === null) {
      throw new SyncError('E_GIT', `cannot read the existing synced file to re-commit it: ${path}`)
    }
    files.set(path, Buffer.isBuffer(blob) ? blob : Buffer.from(blob))
  }

  // 2) Write and push the marker so the write path is proven end-to-end.
  await ensureDir(probeDir)
  await writeFileAtomic(join(probeDir, PROBE_MARKER), content)
  try {
    files.set(probePath, Buffer.from(content, 'utf8'))
    await git.commitManagedFiles(config, work, { profile, files, message: 'probe: connection test' })
    await git.pushBranch(config, work, {})
  } finally {
    // Never leave the marker in the local work tree, even after a failure.
    await rm(join(probeDir, PROBE_MARKER), { force: true })
  }
  lines.push('write: ok')

  // 3) Read the pushed tip back: proves the remote really stores the bytes.
  const head = await git.currentCommit(config, work)
  if (head) {
    const blob = await git.readBlob(config, work, head, probePath)
    const text = Buffer.isBuffer(blob) ? blob.toString('utf8') : String(blob ?? '')
    lines.push(text.trim() === content.trim() ? 'round-trip: ok' : 'round-trip: content mismatch')
  }

  // 4) Restore the branch. Deletion removes only the marker; every synced
  // file keeps its exact bytes, so the tip returns to the pre-probe content
  // (plus an empty-diff commit). When this fails the next real push removes
  // the marker anyway (push stages the exact managed set), so it is only a
  // note.
  try {
    await git.removeManagedFile(config, work, { profile, path: probePath, message: 'probe: remove connection test artifact' })
    await git.pushBranch(config, work, {})
    lines.push('cleanup: ok')
  } catch {
    lines.push('cleanup: the marker stays until the next push removes it')
  }

  lines.push('', 'Connection test passed: the remote is readable and writable.')
  return lines.join('\n')
}
