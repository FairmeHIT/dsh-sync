import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { ACTIVITY_FILE, readActivity, writeFinish, writeStart } from '../src/activity.js'
import { isLocked } from '../src/lock.js'

const tempDirs = []

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-activity-'))
  tempDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('activity record', () => {
  test('reads as null when nothing was recorded', async () => {
    const home = await makeHome()
    assert.equal(await readActivity({ dshHome: home }), null)
  })

  test('round-trips a finished operation', async () => {
    const home = await makeHome()
    const config = { dshHome: home, remote: 'https://example.com/r.git', branch: 'main' }
    await writeStart(config, 'push')
    let record = await readActivity(config)
    assert.equal(record.action, 'push')
    assert.equal(record.finishedAt, null)
    await writeFinish(config, 'push', true, 'Config sync push')
    record = await readActivity(config)
    assert.equal(record.action, 'push')
    assert.equal(record.ok, true)
    assert.equal(record.text, 'Config sync push')
    assert.ok(record.finishedAt)
  })

  test('survives a corrupt file', async () => {
    const home = await makeHome()
    const config = { dshHome: home, remote: 'https://example.com/r.git', branch: 'main' }
    await mkdir(join(home, 'config-sync'), { recursive: true })
    await writeFile(join(home, 'config-sync', ACTIVITY_FILE), '{not json')
    assert.equal(await readActivity(config), null)
  })
})

describe('isLocked', () => {
  test('reports false without a lock and true while one is held', async () => {
    const home = await makeHome()
    assert.equal(await isLocked(home), false)
    const dir = join(home, 'config-sync')
    await mkdir(dir, { recursive: true })
    // A live PID: this process holds the lock file.
    await writeFile(join(dir, 'sync.lock'), `${process.pid}\n${new Date().toISOString()}\n`)
    assert.equal(await isLocked(home), true)
  })

  test('reclaims a stale lock and reports false', async () => {
    const home = await makeHome()
    const dir = join(home, 'config-sync')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'sync.lock')
    await writeFile(file, '999999999\n2020-01-01T00:00:00.000Z\n')
    assert.equal(await isLocked(home), false)
  })
})
