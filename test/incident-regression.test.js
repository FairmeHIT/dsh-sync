import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { normalizeConfig } from '../src/config.js'
import { isLocked, withLock } from '../src/lock.js'
import {
  installRisk,
  missingDependencies,
  pullRisk,
  quarantineManagedFile,
} from '../src/safety.js'
import { pull, push } from '../src/sync.js'
import {
  config,
  hasGit,
  initRemote,
  makeMachine,
  makeRoot,
  pkg,
} from './helpers.js'

const skip = hasGit ? false : 'git is not installed'
const roots = []

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function setup() {
  const root = await makeRoot()
  roots.push(root)
  await initRemote(root)
  return root
}

function patch(text = 'demo-a') {
  return `- insert:\n    - id: ${text}\n      name: dsh-context\n`
}

/** A profile manifest with more dependencies than the one-host fixture. */
function bigPackage(count) {
  const dependencies = {}
  for (let index = 0; index < count; index += 1) dependencies[`dsh-generated-${index}`] = '^1.0.0'
  return `${JSON.stringify(
    {
      name: 'dsh-profile-demo',
      private: true,
      dependencies,
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', 'dsh-generated-0', 'dsh-generated-1'],
        },
      },
    },
    null,
    2,
  )}\n`
}

test('pullRisk/installRisk describe the 2026-11-20 failure shapes', () => {
  const full = {
    plugins: { bundles: ['a', 'b', 'c'], dependencies: { 'p-1': '1', 'p-2': '1', 'p-3': '1' } },
  }
  const empty = { plugins: { bundles: [], dependencies: {} } }
  const risk = pullRisk(full, empty)
  assert.equal(risk.emptiesProfile, true)
  assert.equal(risk.droppedCount, 6)
  assert.equal(installRisk(full, empty).code, 'E_INSTALL_EMPTY')
  // Small profiles are not judged: a two-plugin edit must not block the install.
  assert.equal(installRisk(full, { plugins: { bundles: ['a'], dependencies: { 'p-1': '1' } } }), null)
  const many = {
    plugins: {
      bundles: ['a', 'b'],
      dependencies: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`p-${index}`, '1'])),
    },
  }
  const shrunk = { plugins: { bundles: ['a', 'b'], dependencies: { 'p-0': '1' } } }
  assert.equal(installRisk(many, shrunk).code, 'E_INSTALL_SHRINK')
  assert.equal(installRisk({ plugins: { dependencies: {} } }, empty), null)
})

test('quarantine moves a managed file and refuses anything else', { skip }, async () => {
  const root = await setup()
  const home = await makeMachine(root, 'quarantine', { 'package.json': pkg() })
  const profileDir = join(home, 'profiles', 'demo')
  const quarantine = join(root, 'removed')
  assert.equal(await quarantineManagedFile(profileDir, quarantine, 'package.json'), true)
  await assert.rejects(readFile(join(profileDir, 'package.json')))
  assert.equal(await readFile(join(quarantine, 'package.json'), 'utf8'), pkg())
  await assert.rejects(
    quarantineManagedFile(profileDir, quarantine, 'credentials.yaml'),
    { code: 'E_DELETE_REFUSED' },
  )
})

test('missingDependencies reports declared plugins absent from node_modules', { skip }, async () => {
  const root = await setup()
  const home = await makeMachine(root, 'missing', { 'package.json': pkg() })
  const profileDir = join(home, 'profiles', 'demo')
  const manifest = { plugins: { dependencies: { 'dsh-context': '1', 'dsh-absent': '1' } } }
  await mkdir(join(profileDir, 'node_modules', 'dsh-context'), { recursive: true })
  assert.deepEqual(await missingDependencies(profileDir, manifest), ['dsh-absent'])
})

test('incident regression: a remote copy without cordis.patch.yml never deletes the local patch', { skip }, async (t) => {
  const root = await setup()
  const text = patch('demo-a')
  const homeA = await makeMachine(root, 'homeA', { 'package.json': pkg(), 'cordis.patch.yml': text })
  const homeB = await makeMachine(root, 'homeB', { 'package.json': pkg({ extra: 'dsh-b' }), 'cordis.patch.yml': text })

  await t.test('A publishes the healthy pair and B pulls it', async () => {
    await push(config(root, homeA), { message: 'initial' })
    const pulled = await pull(config(root, homeB), { apply: true })
    assert.match(pulled, /snapshot: /)
    assert.equal(await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'), text)
  })

  await t.test('A loses its patch and pushes only package.json', async () => {
    await rm(join(homeA, 'profiles', 'demo', 'cordis.patch.yml'), { force: true })
    const pushed = await push(config(root, homeA), { message: 'drop the plugin patch' })
    assert.match(pushed, /Pushed\./)
  })

  await t.test('B keeps its only good copy instead of deleting it', async () => {
    const pulled = await pull(config(root, homeB), { apply: true })
    // The exact incident shape: base files must survive an incomplete remote.
    assert.equal(await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'), text)
    assert.match(pulled, /kept locally: cordis\.patch\.yml/)
  })
})

test('incident regression: a pull that would wipe the plugin list is refused until forced', { skip }, async (t) => {
  const root = await setup()
  const homeA = await makeMachine(root, 'homeA', {
    'package.json': pkg(),
    'cordis.patch.yml': patch(),
  })
  await push(config(root, homeA), { message: 'small profile' })

  const homeB = await makeMachine(root, 'homeB', {
    'package.json': bigPackage(8),
    'cordis.patch.yml': patch('demo-b'),
  })
  const configB = config(root, homeB)

  await t.test('apply is refused before anything is written', async () => {
    await assert.rejects(pull(configB, { apply: true }), { code: 'E_DESTRUCTIVE_PULL' })
    assert.equal(
      await readFile(join(homeB, 'profiles', 'demo', 'package.json'), 'utf8'),
      bigPackage(8),
    )
  })

  await t.test('the preview names the removal', async () => {
    const preview = await pull(configB)
    assert.match(preview, /refused unless forced/)
    assert.match(preview, /would remove \d+ of \d+ plugins/)
  })

  await t.test('force applies it and leaves a rollback snapshot', async () => {
    const text = await pull(configB, { apply: true, force: true })
    assert.match(text, /warning: forced pull removed/)
    const stamps = await readdir(join(homeB, 'config-sync', 'snapshots', 'demo'))
    assert.ok(stamps.length >= 1)
    const restored = await readFile(
      join(homeB, 'config-sync', 'snapshots', 'demo', stamps.sort().at(-1), 'profiles', 'demo', 'package.json'),
      'utf8',
    )
    assert.equal(restored, bigPackage(8))
  })
})

test('an apply cannot land on content the preview did not review', { skip }, async () => {
  const root = await setup()
  const homeA = await makeMachine(root, 'homeA', {
    'package.json': pkg(),
    'cordis.patch.yml': patch(),
  })
  await push(config(root, homeA), { message: 'initial' })
  const homeB = await makeMachine(root, 'homeB', {
    'package.json': pkg(),
    'cordis.patch.yml': patch(),
  })
  await assert.rejects(
    pull(config(root, homeB), { apply: true, expectedCommit: '0'.repeat(40) }),
    { code: 'E_STALE_PREVIEW' },
  )
})

test('a live lock is never reclaimed; a dead one is', { skip }, async (t) => {
  const root = await setup()
  const home = await makeMachine(root, 'lock', { 'package.json': pkg() })
  const dir = join(home, 'config-sync')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'sync.lock')

  await t.test('a live PID wins regardless of age', async () => {
    await writeFile(file, `${process.pid}\n${new Date().toISOString()}\nmanual:test\n`)
    assert.equal(await isLocked(home), true)
    await assert.rejects(
      withLock(home, async () => assert.fail('must not enter'), { waitMs: 300 }),
      { code: 'E_BUSY' },
    )
    assert.equal(await isLocked(home), true)
  })

  await t.test('a dead PID is reclaimed on the next writer', async () => {
    await writeFile(file, '999999999\n2020-01-01T00:00:00.000Z\nghost:test\n')
    assert.equal(await isLocked(home), false)
    let entered = false
    await withLock(home, async () => {
      entered = true
    }, { waitMs: 5_000 })
    assert.equal(entered, true)
    await assert.rejects(readFile(file))
  })

  await t.test('a lock owned by a live process is never deleted by a waiter', async () => {
    await writeFile(file, `${process.pid}\nsomeone-else-token\n`)
    await assert.rejects(withLock(home, async () => assert.fail('must not enter'), { waitMs: 250 }), {
      code: 'E_BUSY',
    })
    assert.match(await readFile(file, 'utf8'), /someone-else-token/)
  })
})
