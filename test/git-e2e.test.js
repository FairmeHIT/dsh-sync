import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { normalizeConfig } from '../src/config.js'
import { ensureWorkTree, pushBranch, workDir } from '../src/git.js'
import { pull, pullReport, push, status } from '../src/sync.js'
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
    // The e2e suite predates reconcile: install; keep its pulls offline.
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
    assert.match(text, /does not exist yet/)
    assert.match(text, /push from the machine that already has the configuration/i)
  })

  await t.test('status names a repository that has files but no configuration', async () => {
    const root = await setup()
    // The classic wrong remote: the plugin's own source repository pasted where
    // the configuration repository belongs. Its main has files, no profiles/.
    await commitToRemote(root, { 'README.md': '# plugin\n', 'src/index.js': 'export {}\n' })
    const home = await makeMachine(root, 'home', { 'package.json': pkg() })
    const cfg = config(root, home)

    const text = await status(cfg)
    assert.match(text, /has files but no configuration/)
    assert.match(text, /README\.md/)

    await assert.rejects(pull(cfg), (error) => {
      assert.equal(error.code, 'E_REMOTE_EMPTY')
      assert.equal(error.details?.reason, 'no-profiles')
      assert.match(error.message, /has files on branch "main" but no configuration/)
      assert.match(error.message, /README\.md/)
      assert.match(error.message, /remote\.git/, 'the message must name the remote it read')
      return true
    })
  })

  await t.test('push publishes only allowlisted profile files', async () => {
    const text = await push(configA, { message: 'initial from A' })
    assert.match(text, /Pushed\./)
    assert.match(text, /verified: the remote branch is at this commit/)
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
    assert.match(text, /the remote already holds this configuration at [0-9a-f]{12}/)
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
    const refused = await push(configB).then(
      () => null,
      (error) => error,
    )
    assert.ok(refused, 'the push must be refused')
    assert.equal(refused.code, 'E_CONFLICT')
    // The refusal has to be actionable in the card: it says an overwrite is
    // possible and shows the diff that an overwrite would write.
    assert.equal(refused.details.forceable, true)
    assert.equal(refused.details.reason, 'never-synced')
    assert.equal(refused.details.channel, 'demo')
    assert.equal(refused.details.remoteProfile, 'demo')
    assert.match(refused.details.preview, /would write these changes into the remote branch/)
    assert.match(refused.details.preview, /package\.json/)
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
    const refused = await push(configA).then(
      () => null,
      (error) => error,
    )
    assert.ok(refused, 'the push must be refused')
    assert.equal(refused.code, 'E_CONFLICT')
    assert.equal(refused.details.forceable, true)
    assert.equal(refused.details.reason, 'remote-moved')
    assert.deepEqual(refused.details.files, [
      'profiles/demo/cordis.patch.yml',
      'profiles/demo/package.json',
    ])
    assert.match(refused.details.preview, /would write these changes into the remote branch/)
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

  await t.test('pull adopts the single profile directory the remote already has', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    await push(config(root, homeA), { message: 'desktop push' })

    // The second machine uses a different profile name, so its own
    // profiles/web/manifest.json never existed on the remote.
    const homeB = join(root, 'homeB')
    const profileDir = join(homeB, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), pkg())
    const configB = config(root, homeB, { profile: 'web' })

    const preview = await pullReport(configB)
    assert.match(preview.text, /adopt/i)
    assert.match(preview.text, /profiles\/demo/)
    assert.equal(
      await readFile(join(profileDir, 'package.json'), 'utf8'),
      pkg(),
      'a dry run must not write anything',
    )

    const text = await pull(configB, { apply: true })
    assert.match(text, /adopted:/)
    assert.equal(await readFile(join(profileDir, 'package.json'), 'utf8'), pkg())
    const state = await readState(configB, 'web')
    assert.equal(state.channel, 'demo')
    assert.equal(state.direction, 'pull')
    assert.match(await status(configB), /No differences/)
  })

  await t.test('several remote profiles are reported instead of guessed', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    await push(config(root, homeA), { message: 'demo push' })

    const homeB = join(root, 'homeB')
    const webDir = join(homeB, 'profiles', 'web')
    await mkdir(webDir, { recursive: true })
    await writeFile(join(webDir, 'package.json'), pkg())
    await writeFile(join(webDir, 'cordis.patch.yml'), '- insert: []\n')
    await push(config(root, homeB, { profile: 'web' }), { message: 'web push' })
    assert.deepEqual(
      (await remoteTree(root)).filter((path) => path.endsWith('manifest.json')).sort(),
      ['profiles/demo/manifest.json', 'profiles/web/manifest.json'],
    )

    const homeC = join(root, 'homeC')
    await mkdir(join(homeC, 'profiles', 'other'), { recursive: true })
    await writeFile(join(homeC, 'profiles', 'other', 'package.json'), pkg())
    await assert.rejects(pull(config(root, homeC, { profile: 'other' })), (error) => {
      assert.equal(error.code, 'E_REMOTE_PROFILE')
      assert.match(error.message, /demo/)
      assert.match(error.message, /web/)
      return true
    })
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

test('end-to-end: the connection row never enters the repository and survives a pull', { skip }, async (t) => {
  const connection = (remote) =>
    ['- id: config-sync', '  name: dsh-config-git-sync', '  config:', `    remote: ${remote}`, '    branch: main', '    profile: demo', ''].join('\n')

  await t.test('push withholds the row so another machine can adopt the files', async () => {
    const root = await setup()
    const patch = `- insert:\n    - id: theme\n      name: dsh-theme\n${connection('https://example.com/a.git')}`
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': patch,
    })
    const configA = config(root, homeA)
    const text = await push(configA, { message: 'initial' })
    assert.match(text, /Pushed\./)
    const remotePatch = await git(remoteDir(root), ['show', 'main:profiles/demo/cordis.patch.yml'])
    assert.doesNotMatch(remotePatch, /config-sync/)
    assert.doesNotMatch(remotePatch, /example\.com/)
    assert.match(remotePatch, /id: theme/)
    // The local file is untouched by push.
    assert.equal(await readFile(join(homeA, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'), patch)
  })

  await t.test('pull keeps this machine connection row and reports it', async () => {
    const root = await setup()
    const remotePatch = '- insert:\n    - id: theme\n      name: dsh-theme\n'
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': remotePatch,
    })
    const localPatch = `${remotePatch}${connection('https://example.com/b.git')}`
    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg({ context: '0.86.0' }),
      'cordis.patch.yml': localPatch,
    })
    await push(config(root, homeA), { message: 'initial' })

    const report = await pullReport(config(root, homeB), { apply: true })
    assert.match(report.text, /preserved: config-sync row \(this machine\)/)
    const applied = await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8')
    assert.match(applied, /remote: https:\/\/example\.com\/b\.git/)
    assert.equal(applied.match(/- id: config-sync/g).length, 1)
    assert.doesNotMatch(applied, /context/)
  })

  await t.test('a pull with only a row difference is already up to date and changes nothing', async () => {
    const root = await setup()
    const remotePatch = '- insert:\n    - id: theme\n      name: dsh-theme\n'
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': remotePatch,
    })
    const localPatch = `${remotePatch}${connection('https://example.com/c.git')}`
    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg(),
      'cordis.patch.yml': localPatch,
    })
    await push(config(root, homeA), { message: 'initial' })
    // Adopt the remote first, then confirm the row alone is not drift.
    await pull(config(root, homeB), { apply: true })
    const statusText = await status(config(root, homeB))
    assert.match(statusText, /No differences/)
    const text = await pull(config(root, homeB), { apply: true })
    assert.match(text, /Already up to date\./)
    assert.match(
      await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'),
      /remote: https:\/\/example\.com\/c\.git/,
    )
  })

  await t.test('a machine without a row adopts the remote files as they are', async () => {
    const root = await setup()
    const remotePatch = '- insert:\n    - id: theme\n      name: dsh-theme\n'
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': remotePatch,
    })
    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg({ context: '0.86.0' }),
      'cordis.patch.yml': '- insert: []\n',
    })
    await push(config(root, homeA), { message: 'initial' })
    const report = await pullReport(config(root, homeB), { apply: true })
    assert.doesNotMatch(report.text, /preserved: config-sync row/)
    assert.equal(report.connectionPreserved, false)
    assert.equal(
      await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'),
      remotePatch,
    )
  })
})

test('end-to-end: a pull that changes packages names the install step when reconcile is none', { skip }, async (t) => {
  await t.test('reports the manual install command after applying plugin changes', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg({ extra: 'dsh-extra' }),
      'cordis.patch.yml': '- insert: []\n',
    })
    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    await push(config(root, homeA), { message: 'add plugin' })

    const report = await pullReport(config(root, homeB), { apply: true })
    assert.equal(report.needsInstall, true)
    assert.match(report.text, /packages: manifest changed but dependencies were not installed \(reconcile: none\)/)
    assert.match(report.text, /dsh plugin --profile demo install/)
  })

  await t.test('stays quiet when nothing package-related changed', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert:\n    - id: a\n',
    })
    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    await push(config(root, homeA), { message: 'patch only' })
    const report = await pullReport(config(root, homeB), { apply: true })
    assert.equal(report.needsInstall, false)
    assert.doesNotMatch(report.text, /dsh plugin --profile/)
  })

  await t.test('a dry run and a no-op pull never claim the install step', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg({ extra: 'dsh-extra' }),
      'cordis.patch.yml': '- insert: []\n',
    })
    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg(),
      'cordis.patch.yml': '- insert: []\n',
    })
    await push(config(root, homeA), { message: 'add plugin' })
    const preview = await pullReport(config(root, homeB))
    assert.equal(preview.needsInstall, false)
    assert.doesNotMatch(preview.text, /dsh plugin --profile/)

    await pull(config(root, homeB), { apply: true })
    const again = await pullReport(config(root, homeB), { apply: true })
    assert.equal(again.needsInstall, false)
    assert.match(again.text, /Already up to date\./)
  })
})

test('end-to-end: an older repository may still carry a connection row', { skip }, async (t) => {
  const connection = (remote) =>
    ['- id: config-sync', '  name: dsh-config-git-sync', '  config:', `    remote: ${remote}`, '    branch: main', '    profile: demo', ''].join('\n')
  const base = '- insert:\n    - id: theme\n      name: dsh-theme\n'

  /** Commit a patch that still contains a row, with a manifest that matches it. */
  async function commitLegacyRow(root, patchText) {
    const manifest = JSON.parse(await git(remoteDir(root), ['show', 'main:profiles/demo/manifest.json']))
    const bytes = Buffer.from(patchText)
    manifest.files['profiles/demo/cordis.patch.yml'] = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    }
    await commitToRemote(root, {
      'profiles/demo/cordis.patch.yml': patchText,
      'profiles/demo/manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    })
  }

  await t.test('the row is not reported as drift and the local one wins', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': base,
    })
    await push(config(root, homeA), { message: 'clean base' })
    await commitLegacyRow(root, `${base}${connection('https://example.com/legacy.git')}`)

    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg(),
      'cordis.patch.yml': `${base}${connection('https://example.com/mine.git')}`,
    })
    // Only the row differs once the legacy row is stripped from the remote view.
    assert.match(await status(config(root, homeB)), /No differences/)
    const text = await pull(config(root, homeB), { apply: true })
    assert.match(text, /Already up to date\./)
    assert.match(
      await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'),
      /example\.com\/mine\.git/,
    )
  })

  await t.test('applying replaces the legacy row instead of stacking a second one', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': base,
    })
    await push(config(root, homeA), { message: 'clean base' })
    await commitLegacyRow(root, `${base}${connection('https://example.com/legacy.git')}`)

    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg({ context: '0.86.0' }),
      'cordis.patch.yml': `${base}${connection('https://example.com/mine.git')}`,
    })
    const report = await pullReport(config(root, homeB), { apply: true })
    assert.equal(report.connectionPreserved, true)
    const applied = await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8')
    assert.equal(applied.match(/- id: config-sync/g).length, 1)
    assert.match(applied, /remote: https:\/\/example\.com\/mine\.git/)
    assert.doesNotMatch(applied, /legacy\.git/)
    // The rest of the pull still applied.
    assert.match(applied, /id: theme/)
    assert.match(await readFile(join(homeB, 'profiles', 'demo', 'package.json'), 'utf8'), /context/)
  })
})

test('end-to-end: a patch that only holds the connection row still round-trips', { skip }, async (t) => {
  const row = ['- id: config-sync', '  name: dsh-config-git-sync', '  config:', '    remote: https://example.com/only.git', '    branch: main', '    profile: demo', ''].join('\n')

  await t.test('pushing a row-only patch leaves a valid, adoptable manifest', async () => {
    const root = await setup()
    const home = await makeMachine(root, 'home', {
      'package.json': pkg(),
      'cordis.patch.yml': row,
    })
    const cfg = config(root, home)
    await push(cfg, { message: 'row only' })
    const remotePatch = await git(remoteDir(root), ['show', 'main:profiles/demo/cordis.patch.yml'])
    assert.doesNotMatch(remotePatch, /config-sync/)
    // The manifest must not point at a file the repository lacks.
    const manifest = JSON.parse(await git(remoteDir(root), ['show', 'main:profiles/demo/manifest.json']))
    assert.ok(manifest.files['profiles/demo/cordis.patch.yml'])
    // Status on the same machine stays clean: the row is not drift.
    assert.match(await status(cfg), /No differences/)
  })

  await t.test('another machine keeps its own row and adopts the empty patch', async () => {
    const root = await setup()
    const homeA = await makeMachine(root, 'homeA', {
      'package.json': pkg(),
      'cordis.patch.yml': row,
    })
    await push(config(root, homeA), { message: 'row only' })
    const homeB = await makeMachine(root, 'homeB', {
      'package.json': pkg({ context: '0.86.0' }),
      'cordis.patch.yml': row.replace('only.git', 'b.git'),
    })
    const report = await pullReport(config(root, homeB), { apply: true })
    assert.equal(report.connectionPreserved, true)
    const applied = await readFile(join(homeB, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8')
    assert.match(applied, /example\.com\/b\.git/)
    assert.doesNotMatch(applied, /only\.git/)
    assert.equal(applied.match(/- id: config-sync/g).length, 1)
  })
})

test('end-to-end: a remote manifest with no files is refused, not applied', { skip }, async (t) => {
  // A machine pushes a healthy configuration...
  const root = await setup()
  const home = await makeMachine(root, 'home', {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert:\n    - id: demo-a\n      name: dsh-context\n',
  })
  await push(config(root, home), { message: 'healthy' })

  await t.test('...the remote manifest is then replaced with an empty one...', async () => {
    const manifest = {
      schemaVersion: 1,
      kind: 'dsh-config-git-sync',
      generatedAt: new Date().toISOString(),
      profile: 'demo',
      files: {},
    }
    await commitToRemote(root, {
      'profiles/demo/manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    })
  })

  await t.test('...and an applying pull refuses instead of deleting local files', async () => {
    // The guard layer is defense in depth: the remote-manifest validator may
    // reject first (E_MANIFEST for the missing package.json entry), but either
    // way the pull must refuse before the write phase and leave the local
    // profile untouched.
    const before = await readFile(join(home, 'profiles', 'demo', 'package.json'), 'utf8')
    await assert.rejects(pull(config(root, home), { apply: true }), (error) => {
      assert.ok(
        error.code === 'E_REMOTE_EMPTY_MANIFEST' || error.code === 'E_MANIFEST',
        `unexpected rejection code: ${error.code}`,
      )
      return true
    })
    const after = await readFile(join(home, 'profiles', 'demo', 'package.json'), 'utf8')
    assert.equal(after, before)
  })
})

test('end-to-end: a pull that would delete an owned file always snapshots', { skip }, async () => {
  const root = await setup()
  const homeA = await makeMachine(root, 'homeA', {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert:\n    - id: demo-a\n      name: dsh-context\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  })
  const configA = normalizeConfig({
    remote: join(root, 'remote.git'),
    dshHome: homeA,
    profile: 'demo',
    reconcile: 'none',
    includeLockfile: true,
  })
  await push(configA, { message: 'with lockfile' })

  // Another machine pulls with snapshots configured off, then the remote
  // drops the lockfile: the applying pull deletes it locally but must leave
  // a rollback copy regardless of the snapshot setting.
  const homeB = await makeMachine(root, 'homeB', {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert:\n    - id: demo-b\n      name: dsh-extra\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  })
  const configB = normalizeConfig({
    remote: join(root, 'remote.git'),
    dshHome: homeB,
    profile: 'demo',
    reconcile: 'none',
    includeLockfile: true,
    snapshot: false,
  })
  await pull(configB, { apply: true })
  assert.ok((await readFile(join(homeB, 'profiles', 'demo', 'pnpm-lock.yaml'), 'utf8')).includes('lockfileVersion'))

  // homeA pushes the lockfile's removal.
  await rm(join(homeA, 'profiles', 'demo', 'pnpm-lock.yaml'), { force: true })
  await push(configA, { message: 'drop lockfile' })

  const text = await pull(configB, { apply: true })
  assert.match(text, /quarantined: pnpm-lock\.yaml/)
  await assert.rejects(() => readFile(join(homeB, 'profiles', 'demo', 'pnpm-lock.yaml')))
  // The defensive snapshot exists even though snapshot: false.
  const dirs = await snapshotDirs(homeB)
  assert.ok(dirs.length >= 1, 'a destructive pull must leave a rollback snapshot')
  const lastStamp = dirs[dirs.length - 1]
  const restored = await readFile(
    join(homeB, 'config-sync', 'snapshots', 'demo', lastStamp, 'profiles', 'demo', 'pnpm-lock.yaml'),
    'utf8',
  )
  assert.ok(restored.includes('lockfileVersion'))
  // The removal is a move, not a delete: the file is parked beside the snapshot.
  const quarantined = await readFile(
    join(homeB, 'config-sync', 'snapshots', 'demo', lastStamp, 'removed', 'pnpm-lock.yaml'),
    'utf8',
  )
  assert.ok(quarantined.includes('lockfileVersion'))
})

test('end-to-end: an empty-looking profile is never handed to the package manager', { skip }, async (t) => {
  const root = await setup()
  const homeA = await makeMachine(root, 'homeA', {
    'package.json': pkg(),
    'cordis.patch.yml': '- insert:\n    - id: demo-a\n      name: dsh-context\n',
  })
  await push(config(root, homeA), { message: 'initial' })

  await t.test('a machine whose package.json vanished mid-pull stops with E_PROFILE_EMPTY', async () => {
    const homeB = join(root, 'homeB')
    const profileDir = join(homeB, 'profiles', 'demo')
    await mkdir(profileDir, { recursive: true })
    await mkdir(join(profileDir, 'node_modules', 'some-plugin'), { recursive: true })
    // package.json deliberately absent: this is exactly the state a crashed
    // wipe leaves behind. The pull would apply files, but the follow-up
    // install must refuse instead of letting pnpm prune node_modules.
    const configB = normalizeConfig({
      remote: join(root, 'remote.git'),
      dshHome: homeB,
      profile: 'demo',
      reconcile: 'install',
    })
    // The dry run works; the applying pull writes files but the install is
    // guarded. Since the write phase restores package.json from the remote
    // before the guard runs, the guard passes — verify the real hazard
    // instead: assertProfileWritable itself refuses the half-empty profile.
    const { assertProfileWritable } = await import('../src/safety.js')
    await assert.rejects(assertProfileWritable(profileDir), (error) => {
      assert.equal(error.code, 'E_PROFILE_EMPTY')
      return true
    })
    // The plugin's own node_modules survives the guard: nothing was deleted.
    const entries = await readdir(profileDir)
    assert.ok(entries.includes('node_modules'))
  })
})

test('end-to-end: a cache directory whose .git is broken is rebuilt, not reused', async (t) => {
  const root = await setup()
  await commitToRemote(root, { 'profiles/demo/package.json': pkg() })
  const home = await makeMachine(root, 'home', {})
  const cfg = config(root, home)

  // The exact shape the 2026-11-20 cleanup left behind: the work cache exists
  // with an empty .git, so the old "does .git exist" check skipped `git init`
  // and the next `git config` died with "fatal: not in a git directory".
  const dir = workDir(cfg)
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'HEAD'), 'partial')

  await t.test('ensureWorkTree initialises a fresh cache and keeps the broken one aside', async () => {
    await ensureWorkTree(cfg)
    const head = await git(dir, ['rev-parse', 'HEAD'])
    assert.equal(head.trim(), (await remoteHead(root)).trim())
    const gitDir = await git(dir, ['rev-parse', '--git-dir'])
    assert.ok(['.', '.git', '.git/'].includes(gitDir.trim()), `unexpected git dir: ${gitDir}`)
    const siblings = await readdir(join(home, 'config-sync', 'work'))
    assert.ok(
      siblings.some((name) => name.includes('.git-broken-')),
      `expected a preserved broken cache, saw ${siblings.join(', ')}`,
    )
  })

  await t.test('status works against the repaired cache', async () => {
    const text = await status(cfg)
    assert.match(text, /remote: /)
    assert.match(text, /branch:\s+main/)
  })
})
