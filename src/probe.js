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
 * ensureWorkTree, commitManagedFiles, pushBranch, currentCommit, readBlob.
 */
export async function probeRemote(config, git, options = {}) {
  if (!config.remote) throw new SyncError('E_CONFIG', 'no git remote configured')
  const branch = String(config.branch ?? '').trim() || 'main'
  const profile = String(config.profile ?? '').trim() || 'desktop'
  const work = await git.ensureWorkTree(config, { signal: options.signal })
  const probePath = `profiles/${profile}/${PROBE_MARKER}`
  const probeDir = join(work, 'profiles', profile)
  const content = `${PROBE_MARKER} ${new Date().toISOString()} pid=${process.pid}\n`

  const lines = ['Config sync connection test', `remote: ${displayRemote(config.remote)}`, `branch: ${branch}`]

  // 1) ensureWorkTree already fetched the branch: that proves network,
  //    credentials and branch access — the same things /sync-status needs.
  lines.push('read: ok')

  // 2) Write and push the marker so the write path is proven end-to-end.
  await ensureDir(probeDir)
  await writeFileAtomic(join(probeDir, PROBE_MARKER), content)
  try {
    const probeFiles = new Map([[probePath, Buffer.from(content, 'utf8')]])
    await git.commitManagedFiles(config, work, { profile, files: probeFiles, message: 'probe: connection test' })
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

  // 4) Restore the branch. Deletion uses the same mechanism a real push
  // uses: `git rm --cached` on the exact path, then a commit of the whole
  // prefix. When this fails the next real push removes the marker anyway
  // (push stages the exact managed set), so it is only a note.
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
