import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SyncError } from './errors.js'

const STALE_MS = 30 * 60_000
const WAIT_MS = 2 * 60_000
const POLL_MS = 150

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function staleLock(file) {
  let pid = NaN
  try {
    pid = Number(String(await readFile(file, 'utf8')).split(/\r?\n/)[0])
  } catch {}
  if (Number.isInteger(pid) && pid > 0 && !alive(pid)) return true
  try {
    return Date.now() - (await stat(file)).mtimeMs > STALE_MS
  } catch {
    return false
  }
}

/**
 * Report whether a sync is currently running, without waiting for the lock.
 * The card uses this on remount to restore the busy state instead of letting
 * a user fire a second, rejected request at an in-flight sync.
 */
export async function isLocked(dshHome) {
  const file = join(dshHome, 'config-sync', 'sync.lock')
  try {
    await stat(file)
  } catch {
    return false
  }
  if (await staleLock(file)) {
    await rm(file, { force: true }).catch(() => {})
    return false
  }
  return true
}

/**
 * Serialize cache and state operations for one Harness home. Git operations are
 * not safe to interleave on one work tree, and state.json is read-modify-write.
 * A crashed process leaves a lock that the next caller reclaims by PID/age.
 */
export async function withLock(dshHome, run, options = {}) {
  const dir = join(dshHome, 'config-sync')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'sync.lock')
  const started = Date.now()
  let acquired = false
  while (!acquired) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`)
      await handle.close()
      acquired = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await staleLock(file)) {
        await rm(file, { force: true })
        continue
      }
      if (options.signal?.aborted) {
        throw new SyncError('E_CANCELLED', 'config sync was cancelled while waiting for another sync')
      }
      if (Date.now() - started > WAIT_MS) {
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
    await rm(file, { force: true }).catch(() => {})
  }
}
