import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { STATE_VERSION, readState, statePath, writeState } from '../src/state.js'

const tempDirs = []

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-state-'))
  tempDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const FILES = {
  'profiles/demo/package.json': 'a'.repeat(64),
  'profiles/demo/cordis.patch.yml': 'b'.repeat(64),
}

describe('state', () => {
  test('round-trips one profile and records direction', async () => {
    const home = await makeHome()
    const config = { remote: 'git@example.com:me/repo.git', branch: 'main', dshHome: home }
    await writeState(config, 'demo', { commit: 'abc123', files: FILES, direction: 'pull' })

    const state = await readState(config, 'demo')
    assert.equal(state.profile, 'demo')
    assert.equal(state.commit, 'abc123')
    assert.equal(state.direction, 'pull')
    assert.deepEqual(state.files, FILES)
    assert.match(state.syncedAt, /^\d{4}-\d{2}-\d{2}T/)

    const raw = JSON.parse(await readFile(statePath(home), 'utf8'))
    assert.equal(raw.schemaVersion, STATE_VERSION)
    assert.equal(raw.profiles.demo.remote, config.remote)
  })

  test('preserves other profiles in the same Harness home', async () => {
    const home = await makeHome()
    const config = { remote: 'git@example.com:me/repo.git', branch: 'main', dshHome: home }
    await writeState(config, 'desktop', { commit: 'one', files: {}, direction: 'push' })
    await writeState(config, 'web', { commit: 'two', files: {}, direction: 'pull' })

    assert.equal((await readState(config, 'desktop')).commit, 'one')
    assert.equal((await readState(config, 'web')).direction, 'pull')
  })

  test('invalidates a record when the remote or branch changed', async () => {
    const home = await makeHome()
    const config = { remote: 'git@example.com:me/repo.git', branch: 'main', dshHome: home }
    await writeState(config, 'demo', { commit: 'abc', files: FILES, direction: 'push' })

    assert.equal(
      await readState({ ...config, remote: 'git@example.com:other/repo.git' }, 'demo'),
      null,
    )
    assert.equal(await readState({ ...config, branch: 'config' }, 'demo'), null)
    assert.equal(await readState(config, 'other'), null)
  })

  test('treats a corrupt or unsupported state file as never synced', async () => {
    const home = await makeHome()
    const config = { remote: 'git@example.com:me/repo.git', branch: 'main', dshHome: home }
    const file = statePath(home)
    await mkdir(join(home, 'config-sync'), { recursive: true })
    await writeFile(file, '{ not json')
    assert.equal(await readState(config, 'demo'), null)

    await writeFile(file, JSON.stringify({ schemaVersion: 99, profiles: { demo: { commit: 'x' } } }))
    assert.equal(await readState(config, 'demo'), null)
  })

  test('drops malformed hash entries but keeps the record', async () => {
    const home = await makeHome()
    const config = { remote: 'git@example.com:me/repo.git', branch: 'main', dshHome: home }
    await writeState(config, 'demo', {
      commit: 'abc',
      files: { ...FILES, 'profiles/demo/bad.json': 'not-a-hash' },
      direction: 'push',
    })
    const state = await readState(config, 'demo')
    assert.deepEqual(Object.keys(state.files).sort(), Object.keys(FILES).sort())
  })

  test('does not create a state directory merely by reading', async () => {
    const home = await makeHome()
    const config = { remote: 'git@example.com:me/repo.git', branch: 'main', dshHome: home }
    assert.equal(await readState(config, 'demo'), null)
    await assert.rejects(readFile(join(home, 'config-sync', 'state.json')), { code: 'ENOENT' })
  })
})
