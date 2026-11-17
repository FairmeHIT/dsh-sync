import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { normalizeConfig } from '../src/config.js'
import { ensureWorkTree, pushBranch } from '../src/git.js'
import { pull, push, status } from '../src/sync.js'
import { readState } from '../src/state.js'
import {
  commitSymlink,
  commitToRemote,
  config,
  git,
  gitBuffer,
  hasGit,
  initRemote,
  makeMachine,
  makeRoot,
  pkg,
  remoteHead,
  snapshotDirs,
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

function remoteDir(root) {
  return join(root, 'remote.git')
}

function profileConfig(root, home, profile, extra = {}) {
  return normalizeConfig({
    remote: join(root, 'remote.git'),
    dshHome: home,
    profile,
    reconcile: 'none',
    ...extra,
  })
}

async function makeProfileMachine(root, name, profile, files) {
  const home = join(root, name)
  const profileDir = join(home, 'profiles', profile)
  await mkdir(profileDir, { recursive: true })
  for (const [file, content] of Object.entries(files)) await writeFile(join(profileDir, file), content)
  return home
}

async function remoteTree(root, rev = 'main') {
  const text = await git(remoteDir(root), ['ls-tree', '-r', '--name-only', rev])
  return text ? text.split(/\r?\n/) : []
}

test('end-to-end: push, status, conflict-safe push, pull, force', { skip }, async (t) => {
  const root = await setup()
  const patchA = '- insert:\n    - id: demo-a\n      name: dsh-context\n'
  const homeA = await makeMachine(root, 'homeA', { 'package.json': pkg(), 'cordis.patch.yml': patchA })
  const configA = config(root, homeA)

  await t.test('status reports an empty repository', async () => {
    const text = await status(configA)
    assert.match(text, /no manifest yet/i)
  })

  await t.test('push publishes only allowlisted profile files', async () => {
    const text = await push(configA, { message: 'initial from A' })
    assert.match(text, /Pushed\./)
    assert.match(text, /files:\s+2/)
    assert.deepEqual((await remoteTree(root)).sort(), [
      'profiles/demo/cordis.patch.yml',
      'profiles/demo/manifest.json',
      'profiles/demo/package.json',
    ])
    assert.ok(!(await remoteTree(root)).some((path) => path.includes('credentials')))
    assert.equal(
      await git(remoteDir(root), ['show', 'main:profiles/demo/package.json']),
      pkg().trim(),
    )
    const state = await readState(configA, 'demo')
    assert.equal(state.direction, 'push')
  })

  await t.test('a second push with no local change is a no-op', async () => {
    const before = await remoteHead(root)
    const text = await push(configA)
    assert.match(text, /Already up to date/)
    assert.equal(await remoteHead(root), before)
  })

  await t.test('status is clean and reports the last sync', async () => {
    const text = await status(configA)
    assert.match(text, /No differences/)
    assert.match(text, /last sync: push /)
    assert.match(text, /remote changed since last sync: no/)
  })

  const patchB = '- insert:\n    - id: demo-b\n      name: dsh-extra\n'
  const homeB = await makeMachine(root, 'homeB', {
    'package.json': pkg({ extra: 'dsh-extra', context: '0.86.0' }),
    'cordis.patch.yml': patchB,
  })
  const configB = config(root, homeB)

  await t.test('a fresh machine cannot overwrite a non-empty remote', async () => {
    await assert.rejects(push(configB), { code: 'E_CONFLICT' })
    assert.match(await pull(configB), /dry run/)
  })

  await t.test('pull dry-run writes nothing', async () => {
    const before = await readFile(join(homeB, 'profiles', 'demo', 'package.json'), 'utf8')
    const text = await pull(configB)
    assert.match(text, /dry run/)
    assert.match(text, /Nothing written/)
    assert.equal(await readFile(join(homeB, 'profiles', 'demo', 'package.json'), 'utf8'), before)
  })

  await t.test('pull apply overwrites files and writes a pre-restore snapshot', async () => {
    const before = await readFile(join(homeB, 'profiles', 'demo', 'package.json'), 'utf8')
    const text = await pull(configB, { apply: true })
    assert.match(text, /snapshot: /)
    assert.equal(await readFile(join(homeB, 'profiles', 'demo', 'package.json'), 'utf8'), pkg())
    assert.equal(await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'), patchA)

    const stamps = await snapshotDirs(homeB)
    assert.equal(stamps.length, 1)
    const snapshotFile = join(
      homeB,
      'config-sync',
      'snapshots',
      'demo',
      stamps[0],
      'profiles',
      'demo',
      'package.json',
    )
    assert.equal(await readFile(snapshotFile, 'utf8'), before)
    assert.equal((await readState(configB, 'demo')).direction, 'pull')
  })

  await t.test('a pulled machine can push its own change', async () => {
    await writeFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), patchB)
    await writeFile(
      join(homeB, 'profiles', 'demo', 'package.json'),
      pkg({ extra: 'dsh-extra', context: '0.86.0' }),
    )
    const text = await push(configB, { message: 'from B' })
    assert.match(text, /Pushed\./)
    assert.deepEqual((await git(remoteDir(root), ['log', '--format=%s', 'main'])).split(/\r?\n/), [
      'from B',
      'initial from A',
    ])
  })

  await t.test('status from A sees the remote move and the file diff', async () => {
    const text = await status(configA)
    assert.match(text, /modified\s+profiles\/demo\/cordis.patch.yml/)
    assert.match(text, /remote changed since last sync: yes/)
    assert.match(text, /Plugins to add: dsh-extra@\^1\.0\.0/)
    assert.match(text, /Plugins to change: dsh-context 0\.85\.1 -> 0\.86\.0/)
  })

  await t.test('push refuses to overwrite the remote change without force', async () => {
    await assert.rejects(push(configA), { code: 'E_CONFLICT' })
  })

  await t.test('pull apply adopts the remote change', async () => {
    const text = await pull(configA, { apply: true })
    assert.match(text, /snapshot: /)
    assert.equal(await readFile(join(homeA, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'), patchB)
    const state = await readState(configA, 'demo')
    assert.equal(state.direction, 'pull')
    assert.equal(state.commit, await remoteHead(root))
  })

  await t.test('a machine can push after pulling, and force overwrites divergence', async () => {
    await writeFile(join(homeA, 'profiles', 'demo', 'package.json'), pkg({ extra: 'dsh-extra', context: '0.87.0' }))
    assert.match(await push(configA, { message: 'from A 2' }), /Pushed\./)
    assert.equal((await git(remoteDir(root), ['log', '-1', '--format=%s', 'main'])).trim(), 'from A 2')

    // B is now behind again; a plain push must be refused, force must win.
    await writeFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), '- insert: []\n')
    await assert.rejects(push(configB, { message: 'stale B' }), { code: 'E_CONFLICT' })
    const forced = await push(configB, { force: true, message: 'forced B' })
    assert.match(forced, /mode:\s+forced overwrite/)
    assert.equal((await git(remoteDir(root), ['log', '-1', '--format=%s', 'main'])).trim(), 'forced B')
    assert.equal(
      await git(remoteDir(root), ['show', 'main:profiles/demo/cordis.patch.yml']),
      '- insert: []',
    )
    assert.equal((await readState(configB, 'demo')).commit, await remoteHead(root))
  })
})

test('end-to-end: optional lockfile and workspace files', { skip }, async () => {
  const root = await setup()
  const home = await makeMachine(root, 'home', {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert: []\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'pnpm-workspace.yaml': 'packages:\n  - .\nallowBuilds:\n  esbuild: true\n',
  })
  const withFiles = config(root, home, { includeLockfile: true, includeWorkspace: true })
  assert.match(await push(withFiles, { message: 'with files' }), /files:\s+4/)
  let tree = await remoteTree(root)
  assert.ok(tree.includes('profiles/demo/pnpm-lock.yaml'))
  assert.ok(tree.includes('profiles/demo/pnpm-workspace.yaml'))

  const withoutFiles = config(root, home)
  assert.match(await push(withoutFiles, { message: 'drop files' }), /Pushed\./)
  tree = await remoteTree(root)
  assert.deepEqual(tree.sort(), [
    'profiles/demo/cordis.patch.yml',
    'profiles/demo/manifest.json',
    'profiles/demo/package.json',
  ])
  // The local optional files stay on disk; only the remote mirror is trimmed.
  assert.equal(await readFile(join(home, 'profiles', 'demo', 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9\n')
})

test('end-to-end: exact bytes survive CRLF and remote Git attributes', { skip }, async () => {
  const root = await setup()
  const rawPackage = pkg().trimEnd()
  const crlfPatch = '- insert:\r\n    - id: demo\r\n      name: dsh-context\r\n'
  const homeA = await makeMachine(root, 'homeA', {
    'package.json': rawPackage,
    'cordis.patch.yml': crlfPatch,
  })
  const configA = config(root, homeA)
  await push(configA, { message: 'exact bytes' })

  let remotePackage = await gitBuffer(remoteDir(root), ['cat-file', 'blob', 'main:profiles/demo/package.json'])
  assert.deepEqual(remotePackage, Buffer.from(rawPackage))
  let remotePatch = await gitBuffer(remoteDir(root), ['cat-file', 'blob', 'main:profiles/demo/cordis.patch.yml'])
  assert.deepEqual(remotePatch, Buffer.from(crlfPatch))

  // A user (or another tool) adds a repository-wide attribute that would
  // rewrite line endings in a normal checkout.
  await commitToRemote(
    root,
    { '.gitattributes': '* text eol=crlf\n' },
    { message: 'add gitattributes' },
  )

  const changedPatch = '- insert:\r\n    - id: demo-2\r\n'
  await writeFile(join(homeA, 'profiles', 'demo', 'cordis.patch.yml'), changedPatch)
  const text = await push(configA, { message: 'after attributes' })
  assert.match(text, /Pushed\./)
  remotePackage = await gitBuffer(remoteDir(root), ['cat-file', 'blob', 'main:profiles/demo/package.json'])
  assert.deepEqual(remotePackage, Buffer.from(rawPackage))
  remotePatch = await gitBuffer(remoteDir(root), ['cat-file', 'blob', 'main:profiles/demo/cordis.patch.yml'])
  assert.deepEqual(remotePatch, Buffer.from(changedPatch))
  assert.ok((await remoteTree(root)).includes('.gitattributes'))

  const homeB = await makeMachine(root, 'homeB', {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert: []\n',
  })
  await pull(config(root, homeB), { apply: true })
  assert.deepEqual(await readFile(join(homeB, 'profiles', 'demo', 'package.json')), Buffer.from(rawPackage))
  assert.deepEqual(
    await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml')),
    Buffer.from(changedPatch),
  )
})

test('end-to-end: malformed or unsafe remotes fail closed', { skip }, async (t) => {
  await t.test('unknown path inside the profile directory is rejected', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    const cfg = config(root, home)
    await push(cfg, { message: 'initial' })
    await commitToRemote(root, { 'profiles/demo/extra.txt': 'unexpected\n' })
    await assert.rejects(status(cfg), { code: 'E_PATH' })
  })

  await t.test('missing manifest-referenced file is rejected', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    const cfg = config(root, home)
    await push(cfg, { message: 'initial' })
    await commitToRemote(root, { 'profiles/demo/cordis.patch.yml': null })
    await assert.rejects(status(cfg), { code: 'E_MANIFEST' })
  })

  await t.test('hash mismatch is rejected', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    const cfg = config(root, home)
    await push(cfg, { message: 'initial' })
    await commitToRemote(root, { 'profiles/demo/package.json': pkg({ context: '9.9.9' }).trimEnd() })
    await assert.rejects(status(cfg), { code: 'E_MANIFEST' })
  })

  await t.test('symlinked manifest is rejected before reading it', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    const cfg = config(root, home)
    await push(cfg, { message: 'initial' })
    await commitSymlink(root, 'profiles/demo/manifest.json', 'C:\\outside\\secret.json')
    await assert.rejects(status(cfg), { code: 'E_PATH' })
  })

  await t.test('path traversal in the manifest is rejected', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    const cfg = config(root, home)
    await push(cfg, { message: 'initial' })
    const manifest = JSON.parse(await git(remoteDir(root), ['show', 'main:profiles/demo/manifest.json']))
    manifest.files['profiles/demo/../evil'] = { sha256: 'a'.repeat(64), size: 1 }
    await commitToRemote(root, {
      'profiles/demo/manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    })
    await assert.rejects(status(cfg), { code: 'E_PATH' })
  })

  await t.test('profile mismatch is rejected', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    const cfg = config(root, home)
    await push(cfg, { message: 'initial' })
    const manifest = JSON.parse(await git(remoteDir(root), ['show', 'main:profiles/demo/manifest.json']))
    manifest.profile = 'other'
    await commitToRemote(root, {
      'profiles/demo/manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    })
    await assert.rejects(status(cfg), { code: 'E_PROFILE_MISMATCH' })
  })
})

test('end-to-end: empty remote and orphan branch', { skip }, async (t) => {
  await t.test('pull rejects an empty remote instead of guessing', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', { 'package.json': pkg() })
    await assert.rejects(pull(config(root, home)), { code: 'E_REMOTE_EMPTY' })
  })

  await t.test('a branch absent from the remote starts a new root commit', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    const mainConfig = config(root, home)
    await push(mainConfig, { message: 'main head' })

    const branchConfig = normalizeConfig({ ...mainConfig, branch: 'config' })
    const text = await push(branchConfig, { message: 'config root' })
    assert.match(text, /Pushed\./)
    assert.equal(
      (await git(remoteDir(root), ['rev-list', '--count', 'config'])).trim(),
      '1',
      'the new branch must not inherit main history',
    )
    assert.deepEqual((await remoteTree(root, 'config')).sort(), [
      'profiles/demo/cordis.patch.yml',
      'profiles/demo/manifest.json',
      'profiles/demo/package.json',
    ])
    assert.equal((await git(remoteDir(root), ['rev-list', '--count', 'main'])).trim(), '1')
    assert.equal((await readState(branchConfig, 'demo')).commit, await remoteHead(root, 'config'))
  })

  await t.test('a stale push is rejected by the remote', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    const cfg = config(root, home)
    await push(cfg, { message: 'initial' })
    const work = await ensureWorkTree(cfg)
    await commitToRemote(root, { 'profiles/demo/extra.txt': 'foreign\n' })
    await assert.rejects(pushBranch(cfg, work), { code: 'E_PUSH_REJECTED' })
  })
})

test('end-to-end: snapshot retention and state adoption', { skip }, async (t) => {
  await t.test('keeps only the requested number of snapshots', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert:\n    - id: one\n',
    })
    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert:\n    - id: before\n',
    })
    const configA = config(root, homeA)
    const configB = config(root, homeB, { snapshotKeep: 2 })
    await push(configA, { message: 'one' })

    await pull(configB, { apply: true })
    for (const id of ['two', 'three']) {
      await writeFile(join(homeA, 'profiles', 'demo', 'cordis.patch.yml'), `- insert:\n    - id: ${id}\n`)
      await push(configA, { message: id })
      await pull(configB, { apply: true })
    }
    const stamps = await snapshotDirs(homeB)
    assert.equal(stamps.length, 2)
    const newest = await readFile(
      join(homeB, 'config-sync', 'snapshots', 'demo', stamps[1], 'profiles', 'demo', 'cordis.patch.yml'),
      'utf8',
    )
    assert.equal(newest, '- insert:\n    - id: two\n')
  })

  await t.test('an identical push adopts the remote commit into local state', async () => {
    const root = await setup()
    const files = { 'package.json': pkg(), 'cordis.patch.yml': '- insert: []\n' }
    const homeA = await makeMachine(root, 'homeA', files)
    const homeB = await makeMachine(root, 'homeB', files)
    const configA = config(root, homeA)
    const configB = config(root, homeB)
    await push(configA, { message: 'initial' })
    const head = await remoteHead(root)

    const text = await push(configB)
    assert.match(text, /Already up to date/)
    assert.equal((await readState(configB, 'demo')).commit, head)

    await writeFile(join(homeA, 'profiles', 'demo', 'cordis.patch.yml'), '- insert:\n    - id: moved\n')
    await push(configA, { message: 'moved' })
    await assert.rejects(push(configB), { code: 'E_CONFLICT' })
  })

  await t.test('secret scanning warns but does not block', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': '- config:\n    apiKey: sk-abcdefghijklmnopqrstuvwxyz012345\n',
    })
    const text = await push(config(root, home), { message: 'secret warning' })
    assert.match(text, /Pushed\./)
    assert.match(text, /Possible inline credentials/)
    assert.match(text, /apiKey has an inline value/)

    await writeFile(join(home, 'profiles', 'demo', 'cordis.patch.yml'), '- insert: []\n')
    const silent = await push(config(root, home, { secretScan: 'off' }), { message: 'quiet' })
    assert.doesNotMatch(silent, /Possible inline credentials/)
  })
})

test('end-to-end: a deleted remote branch is rebuilt as a root commit', { skip }, async () => {
  const root = await setup()
  const home = await makeMachine(root, 'home', {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert: []\n',
  })
  const cfg = config(root, home)
  await push(cfg, { message: 'initial' })
  await git(remoteDir(root), ['update-ref', '-d', 'refs/heads/main'])

  const text = await push(cfg, { message: 'after delete' })
  assert.match(text, /Pushed\./)
  assert.equal((await git(remoteDir(root), ['rev-list', '--count', 'main'])).trim(), '1')
  assert.equal((await git(remoteDir(root), ['log', '--format=%s', 'main'])).trim(), 'after delete')
})

test('end-to-end: status and pull restore a missing package.json', { skip }, async () => {
  const root = await setup()
  const files = { 'package.json': pkg(), 'cordis.patch.yml': '- insert: []\n' }
  const homeA = await makeMachine(root, 'homeA', files)
  const homeB = await makeMachine(root, 'homeB', files)
  await push(config(root, homeA), { message: 'initial' })
  await rm(join(homeB, 'profiles', 'demo', 'package.json'))

  const statusText = await status(config(root, homeB))
  assert.match(statusText, /added\s+profiles\/demo\/package\.json/)
  const pullText = await pull(config(root, homeB), { apply: true })
  assert.match(pullText, /snapshot: /)
  assert.equal(await readFile(join(homeB, 'profiles', 'demo', 'package.json'), 'utf8'), pkg())
})

test('end-to-end: pull keeps a local file the remote never managed', { skip }, async () => {
  const root = await setup()
  const localPatch = '- insert:\n    - id: local-only\n      name: dsh-local\n'
  const homeA = await makeMachine(root, 'homeA', { 'package.json': pkg() })
  const homeB = await makeMachine(root, 'homeB', {
    'package.json': pkg(),
    'cordis.patch.yml': localPatch,
  })
  await push(config(root, homeA), { message: 'no patch' })

  const text = await pull(config(root, homeB), { apply: true })
  assert.match(text, /kept locally: cordis\.patch\.yml/)
  assert.equal(
    await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'),
    localPatch,
  )
})

test('end-to-end: an unmanaged optional file is preserved by push, an owned one can be removed', { skip }, async () => {
  const root = await setup()
  const files = {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert: []\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  }
  const homeA = await makeMachine(root, 'homeA', files)
  const homeB = await makeMachine(root, 'homeB', files)
  const configA = config(root, homeA, { includeLockfile: true })
  const configB = config(root, homeB)

  await push(configA, { message: 'with lockfile' })
  // A owns the lockfile, so turning the option off intentionally removes it.
  const removed = await push(normalizeConfig({ ...configA, includeLockfile: false }), {
    message: 'remove owned lockfile',
  })
  assert.match(removed, /Pushed\./)
  assert.ok(!(await remoteTree(root)).includes('profiles/demo/pnpm-lock.yaml'))

  // Publish it again so a machine that does not opt in can exercise preservation.
  await push(configA, { message: 'restore lockfile' })
  assert.ok((await remoteTree(root)).includes('profiles/demo/pnpm-lock.yaml'))

  await pull(configB, { apply: true })
  await writeFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), '- insert:\n    - id: b\n')
  const text = await push(configB, { message: 'B change' })
  assert.match(text, /preserved: pnpm-lock\.yaml/)
  assert.ok((await remoteTree(root)).includes('profiles/demo/pnpm-lock.yaml'))
})

test('end-to-end: multiple profiles share one repository', { skip }, async () => {
  const root = await setup()
  const home = await makeProfileMachine(root, 'home', 'demo', {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert: []\n',
  })
  await makeProfileMachine(root, 'home', 'web', {
    'package.json': pkg({ context: '0.90.0' }),
    'cordis.patch.yml': '- insert:\n    - id: web\n',
  })
  const demoConfig = profileConfig(root, home, 'demo')
  const webConfig = profileConfig(root, home, 'web')

  await push(demoConfig, { message: 'demo' })
  await push(webConfig, { message: 'web' })
  let tree = await remoteTree(root)
  assert.ok(tree.includes('profiles/demo/package.json'))
  assert.ok(tree.includes('profiles/web/package.json'))

  await writeFile(join(home, 'profiles', 'demo', 'cordis.patch.yml'), '- insert:\n    - id: demo2\n')
  await push(demoConfig, { message: 'demo2' })
  tree = await remoteTree(root)
  assert.ok(tree.includes('profiles/web/package.json'))
  assert.equal(
    await git(remoteDir(root), ['show', 'main:profiles/web/package.json']),
    pkg({ context: '0.90.0' }).trim(),
  )
})
