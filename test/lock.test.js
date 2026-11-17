import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, describe, test } from 'node:test'
import { withLock } from '../src/lock.js'

const tempDirs = []

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-lock-'))
  tempDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('withLock', () => {
  test('releases the lock after success and failure', async () => {
    const home = await makeHome()
    assert.equal(await withLock(home, async () => 42), 42)
    await assert.rejects(
      withLock(home, async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    await assert.rejects(readFile(join(home, 'config-sync', 'sync.lock')), { code: 'ENOENT' })
  })

  test('serializes concurrent callers', async () => {
    const home = await makeHome()
    const events = []
    await Promise.all([
      withLock(home, async () => {
        events.push('a-start')
        await delay(120)
        events.push('a-end')
      }),
      withLock(home, async () => {
        events.push('b-start')
        events.push('b-end')
      }),
    ])
    // The lock guarantees mutual exclusion, not acquisition order: both
    // callers start together and either may win the open(O_EXCL) race.
    const expected =
      events[0] === 'a-start'
        ? ['a-start', 'a-end', 'b-start', 'b-end']
        : ['b-start', 'b-end', 'a-start', 'a-end']
    assert.deepEqual(events, expected)
  })

  test('reclaims a lock left by a dead process', async () => {
    const home = await makeHome()
    const file = join(home, 'config-sync', 'sync.lock')
    await mkdir(join(home, 'config-sync'), { recursive: true })
    await writeFile(file, '999999999\n2020-01-01T00:00:00.000Z\n')
    assert.equal(await withLock(home, async () => 'reclaimed'), 'reclaimed')
    await assert.rejects(readFile(file), { code: 'ENOENT' })
  })
})
