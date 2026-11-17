import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { detectProfile, deviceId, deviceInfo, isValidProfileName, listProfiles, readDshVersion } from '../src/paths.js'

const tempDirs = []

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-paths-'))
  tempDirs.push(dir)
  return dir
}

async function makeProfile(home, name, packageJson) {
  const dir = join(home, 'profiles', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(packageJson))
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('detectProfile', () => {
  test('prefers an explicit profile without touching disk', async () => {
    assert.equal(await detectProfile('C:\\missing', 'chosen', 'dsh-config-sync'), 'chosen')
  })

  test('rejects explicit profile names that are unsafe path segments', async () => {
    for (const name of ['..', '../escape', 'a/b', 'a\\b', '', '.hidden']) {
      if (name === '') continue
      await assert.rejects(detectProfile('C:\\missing', name, 'dsh-config-sync'), { code: 'E_PROFILE' }, name)
    }
  })

  test('finds the profile whose manifest lists the bundle', async () => {
    const home = await makeHome()
    await makeProfile(home, 'alpha', { dsh: { profile: { bundles: ['other'] } } })
    await makeProfile(home, 'beta', { dsh: { profile: { bundles: ['dsh-config-sync'] } } })
    assert.equal(await detectProfile(home, '', 'dsh-config-sync'), 'beta')
  })

  test('finds a profile that only declares a dependency', async () => {
    const home = await makeHome()
    await makeProfile(home, 'alpha', { dependencies: { 'dsh-config-sync': 'link:..' } })
    assert.equal(await detectProfile(home, '', 'dsh-config-sync'), 'alpha')
  })

  test('prefers desktop when several profiles match', async () => {
    const home = await makeHome()
    await makeProfile(home, 'work', { dsh: { profile: { bundles: ['dsh-config-sync'] } } })
    await makeProfile(home, 'desktop', { dsh: { profile: { bundles: ['dsh-config-sync'] } } })
    assert.equal(await detectProfile(home, '', 'dsh-config-sync'), 'desktop')
  })

  test('uses the only profile when nothing matches', async () => {
    const home = await makeHome()
    await makeProfile(home, 'solo', { dsh: { profile: { bundles: ['other'] } } })
    assert.equal(await detectProfile(home, '', 'dsh-config-sync'), 'solo')
  })

  test('throws E_PROFILE when the choice is ambiguous', async () => {
    const home = await makeHome()
    await makeProfile(home, 'one', { dsh: { profile: { bundles: ['other'] } } })
    await makeProfile(home, 'two', { dsh: { profile: { bundles: ['other'] } } })
    await assert.rejects(detectProfile(home, '', 'dsh-config-sync'), { code: 'E_PROFILE' })
  })

  test('rejects an unsafe auto-detected profile name', async () => {
    const home = await makeHome()
    await makeProfile(home, 'bad name', { dsh: { profile: { bundles: ['dsh-config-sync'] } } })
    await assert.rejects(detectProfile(home, '', 'dsh-config-sync'), { code: 'E_PROFILE' })
  })
})

describe('device identity', () => {
  test('is stable across calls and persisted under the harness home', async () => {
    const home = await makeHome()
    const first = await deviceId(home)
    const second = await deviceId(home)
    assert.equal(first, second)
    assert.match(first, /^[0-9a-f-]{36}$/)
    const stored = JSON.parse(await readFile(join(home, 'config-sync', 'device.json'), 'utf8'))
    assert.equal(stored.id, first)
  })

  test('does not expose the machine id in the informational payload', async () => {
    const info = deviceInfo('dev-1')
    assert.equal(info.id, 'dev-1')
    assert.equal(typeof info.host, 'string')
    assert.equal(typeof info.platform, 'string')
  })
})

describe('listProfiles', () => {
  test('returns directory names and tolerates a missing home', async () => {
    const home = await makeHome()
    await makeProfile(home, 'desktop', {})
    await makeProfile(home, 'web', {})
    assert.deepEqual((await listProfiles(home)).sort(), ['desktop', 'web'])
    assert.deepEqual(await listProfiles(join(home, 'nope')), [])
  })
})

describe('readDshVersion', () => {
  test('prefers DSH_VERSION and reads the installed package manifest', async () => {
    const previousVersion = process.env.DSH_VERSION
    const previousInstall = process.env.DSH_INSTALL_DIR
    const install = await makeHome()
    await writeFile(join(install, 'package.json'), JSON.stringify({ version: '9.8.7' }))
    try {
      process.env.DSH_VERSION = '1.2.3'
      process.env.DSH_INSTALL_DIR = install
      assert.equal(await readDshVersion(), '1.2.3')

      delete process.env.DSH_VERSION
      assert.equal(await readDshVersion(), '9.8.7')
    } finally {
      if (previousVersion === undefined) delete process.env.DSH_VERSION
      else process.env.DSH_VERSION = previousVersion
      if (previousInstall === undefined) delete process.env.DSH_INSTALL_DIR
      else process.env.DSH_INSTALL_DIR = previousInstall
    }
  })

  test('returns null when no installation can be identified', async () => {
    const previousVersion = process.env.DSH_VERSION
    const previousInstall = process.env.DSH_INSTALL_DIR
    try {
      delete process.env.DSH_VERSION
      delete process.env.DSH_INSTALL_DIR
      assert.equal(await readDshVersion(), null)
    } finally {
      if (previousVersion !== undefined) process.env.DSH_VERSION = previousVersion
      if (previousInstall !== undefined) process.env.DSH_INSTALL_DIR = previousInstall
    }
  })
})
