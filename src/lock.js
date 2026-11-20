import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SyncError } from './errors.js'

const WAIT_MS = 2 * 60_000
const POLL_MS = 150
/**
 * A lock file written without a PID (a crash between `open` and `write`) is
 * treated as stale after a short grace period instead of blocking sync for
 * half an hour.
 */
const EMPTY_GRACE_MS = 10_000

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function readLock(file) {
  try {
    const info = await stat(file)
    const text = await readFile(file, 'utf8')
    const pid = Number(String(text).split(/\r?\n/)[0])
    return { pid: Number.isInteger(pid) && pid > 0 ? pid : NaN, text, ageMs: Date.now() - info.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Decide whether a lock file belongs to a dead or crashed process. A live PID
 * always wins, whatever the file's age: a slow but healthy install must never
 * be pre-empted by a second sync.
 */
function staleFrom(lock) {
  if (!lock) return false
  if (Number.isInteger(lock.pid) && lock.pid > 0) return !alive(lock.pid)
  return lock.ageMs > EMPTY_GRACE_MS
}

/**
 * Take a stale lock aside atomically, then verify it really was the stale one.
 * If another waiter already replaced it with a fresh lock, put the fresh file
 * back and report failure instead of unlinking someone else's lock.
 */
async function reclaim(file, stalePid) {
  const aside = `${file}.${process.pid}.${Date.now()}.stale`
  try {
    await rename(file, aside)
  } catch {
    return false
  }
  const taken = await readFile(aside, 'utf8').catch(() => '')
  const pid = Number(String(taken).split(/\r?\n/)[0])
  if (Number.isInteger(pid) && pid > 0 && pid !== stalePid) {
    // We raced a fresh owner: restore its lock and let the caller retry.
    await rename(aside, file).catch(() => {})
    return false
  }
  await rm(aside, { force: true }).catch(() => {})
  return true
}

/**
 * Report whether a sync is currently running, without waiting for the lock.
 * Read-only: the card uses this on remount to restore the busy state, and a GET
 * must never mutate lock files (a stale one is reclaimed only by a writer).
 */
export async function isLocked(dshHome) {
  const lock = await readLock(join(dshHome, 'config-sync', 'sync.lock'))
  if (!lock) return false
  return !staleFrom(lock)
}

/** Remove the lock only when this process still owns it. */
async function releaseOwn(file, token) {
  const lock = await readLock(file)
  if (!lock || !lock.text.includes(token)) return
  await rm(file, { force: true }).catch(() => {})
}

/**
 * Serialize cache and state operations for one Harness home. Git operations are
 * not safe to interleave on one work tree, and state.json is read-modify-write.
 * A crashed process leaves a lock that the next caller reclaims by PID (a live
 * PID is never pre-empted); the owner token keeps a slow caller from deleting a
 * successor's lock.
 */
export async function withLock(dshHome, run, options = {}) {
  const dir = join(dshHome, 'config-sync')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'sync.lock')
  const token = `${process.pid}:${randomUUID()}`
  const started = Date.now()
  const waitMs = options.waitMs ?? WAIT_MS
  let acquired = false
  while (!acquired) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n${token}\n`)
      await handle.close()
      acquired = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const lock = await readLock(file)
      if (staleFrom(lock) && (await reclaim(file, lock?.pid))) continue
      if (options.signal?.aborted) {
        throw new SyncError('E_CANCELLED', 'config sync was cancelled while waiting for another sync')
      }
      if (Date.now() - started > waitMs) {
        throw new SyncError(
          'E_BUSY',
          `another config sync is running (lock: ${file}); wait for it to finish, or remove the file if you are sure no other sync is active (a live PID can rarely be a reused process id)`,
        )
      }
      await delay(POLL_MS)
    }
  }
  try {
    return await run()
  } finally {
    await releaseOwn(file, token)
  }
}
