import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  allowedFiles,
  buildManifest,
  changedFiles,
  dependencyVersion,
  diffManifests,
  manifestPath,
  parseManifest,
  readLocalFiles,
  requirePackageJson,
  summarizeDiff,
  validateSyncPath,
} from '../src/manifest.js'

const tempDirs = []

async function makeProfile(files) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-manifest-'))
  tempDirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const PKG = JSON.stringify({
  name: 'dsh-profile-demo',
  private: true,
  dependencies: { 'dsh-context': '0.85.1', local: 'link:../local' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context'] } },
})

describe('allowedFiles', () => {
  test('always includes package.json and cordis.patch.yml', () => {
    assert.deepEqual(allowedFiles(false), ['package.json', 'cordis.patch.yml'])
  })

  test('adds optional files only when requested', () => {
    assert.deepEqual(allowedFiles(true), ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'])
    assert.deepEqual(allowedFiles(false, true), ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'])
    assert.deepEqual(allowedFiles(true, true), [
      'package.json',
      'cordis.patch.yml',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ])
  })
})

describe('readLocalFiles', () => {
  test('reads allowlisted files under the profile prefix', async () => {
    const dir = await makeProfile({ 'package.json': PKG, 'cordis.patch.yml': '- insert: []\n' })
    const files = await readLocalFiles(dir, 'demo', false)
    assert.deepEqual([...files.keys()].sort(), [
      'profiles/demo/cordis.patch.yml',
      'profiles/demo/package.json',
    ])
  })

  test('ignores missing optional files and the lockfile by default', async () => {
    const dir = await makeProfile({
      'package.json': PKG,
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'pnpm-workspace.yaml': 'packages:\n  - .\n',
    })
    const files = await readLocalFiles(dir, 'demo', false)
    assert.deepEqual([...files.keys()], ['profiles/demo/package.json'])
  })

  test('includes optional files when requested', async () => {
    const dir = await makeProfile({
      'package.json': PKG,
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'pnpm-workspace.yaml': 'packages:\n  - .\n',
    })
    const withLock = await readLocalFiles(dir, 'demo', true)
    assert.ok(withLock.has('profiles/demo/pnpm-lock.yaml'))
    const withWorkspace = await readLocalFiles(dir, 'demo', false, true)
    assert.ok(withWorkspace.has('profiles/demo/pnpm-workspace.yaml'))
    assert.ok(!withWorkspace.has('profiles/demo/pnpm-lock.yaml'))
  })

  test('tolerates a missing package.json but push can require it', async () => {
    const dir = await makeProfile({ 'cordis.patch.yml': '- insert: []\n' })
    const files = await readLocalFiles(dir, 'demo', false)
    assert.deepEqual([...files.keys()], ['profiles/demo/cordis.patch.yml'])
    assert.throws(() => requirePackageJson(files, dir), { code: 'E_PROFILE' })
  })
})

describe('buildManifest', () => {
  test('records hashes, size and plugin metadata', async () => {
    const dir = await makeProfile({ 'package.json': PKG, 'cordis.patch.yml': 'patch\n' })
    const files = await readLocalFiles(dir, 'demo', false)
    const manifest = buildManifest({
      profile: 'demo',
      files,
      dshVersion: '9.9.9',
      device: { id: 'dev', host: 'host', platform: 'test' },
      generatedAt: new Date('2026-01-02T03:04:05.000Z'),
    })

    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.kind, 'dsh-config-git-sync')
    assert.equal(manifest.profile, 'demo')
    assert.equal(manifest.dshVersion, '9.9.9')
    assert.equal(manifest.generatedAt, '2026-01-02T03:04:05.000Z')
    assert.deepEqual(manifest.plugins.bundles, ['@deepseek-ai/dsh-base', 'dsh-context'])
    assert.deepEqual(manifest.plugins.dependencies, { 'dsh-context': '0.85.1', local: 'link:../local' })
    assert.equal(manifest.files['profiles/demo/package.json'].size, Buffer.byteLength(PKG))
    assert.match(manifest.files['profiles/demo/package.json'].sha256, /^[0-9a-f]{64}$/)
  })

  test('rejects invalid package.json', async () => {
    const dir = await makeProfile({ 'package.json': '{ nope' })
    const files = await readLocalFiles(dir, 'demo', false)
    assert.throws(() => buildManifest({ profile: 'demo', files }), { code: 'E_MANIFEST' })
  })
})

describe('parseManifest', () => {
  test('round-trips a built manifest', async () => {
    const dir = await makeProfile({ 'package.json': PKG })
    const files = await readLocalFiles(dir, 'demo', false)
    const manifest = buildManifest({ profile: 'demo', files })
    assert.deepEqual(parseManifest(Buffer.from(JSON.stringify(manifest))), manifest)
  })

  test('rejects invalid JSON with a stable code', () => {
    assert.throws(() => parseManifest('{ nope'), { code: 'E_MANIFEST' })
  })

  test('rejects unknown schema versions', () => {
    assert.throws(() => parseManifest(JSON.stringify({ schemaVersion: 2, files: {} })), {
      code: 'E_MANIFEST',
    })
  })

  test('rejects a manifest without a files table', () => {
    assert.throws(() => parseManifest(JSON.stringify({ schemaVersion: 1 })), { code: 'E_MANIFEST' })
    assert.throws(() => parseManifest(JSON.stringify({ schemaVersion: 1, files: [] })), {
      code: 'E_MANIFEST',
    })
  })

  test('rejects malformed file entries instead of trusting them', () => {
    for (const files of [
      { 'profiles/demo/package.json': null },
      { 'profiles/demo/package.json': {} },
      { 'profiles/demo/package.json': { sha256: 'not-a-hash' } },
      { 'profiles/demo/package.json': { sha256: 'a'.repeat(64), size: -1 } },
      { 'profiles/demo/package.json': { sha256: 'a'.repeat(64), size: 1.5 } },
    ]) {
      assert.throws(() => parseManifest(JSON.stringify({ schemaVersion: 1, files })), {
        code: 'E_MANIFEST',
      })
    }
  })
})

describe('validateSyncPath', () => {
  test('accepts allowlisted profile files', () => {
    assert.equal(
      validateSyncPath('profiles/demo/package.json', 'demo', false),
      'profiles/demo/package.json',
    )
    assert.equal(
      validateSyncPath('profiles\\demo\\cordis.patch.yml', 'demo', false),
      'profiles/demo/cordis.patch.yml',
    )
  })

  test('rejects traversal, absolute paths and NUL bytes', () => {
    for (const path of [
      'profiles/demo/../../etc/passwd',
      'profiles/demo/sub/../../package.json',
      '/etc/passwd',
      'profiles/demo/package.json\0.txt',
    ]) {
      assert.throws(() => validateSyncPath(path, 'demo', false), { code: 'E_PATH' }, path)
    }
  })

  test('rejects another profile and unknown files', () => {
    assert.throws(() => validateSyncPath('profiles/other/package.json', 'demo', false), {
      code: 'E_PATH',
    })
    assert.throws(() => validateSyncPath('profiles/demo/.credentials.yaml', 'demo', false), {
      code: 'E_PATH',
    })
    assert.throws(() => validateSyncPath('profiles/demo/pnpm-lock.yaml', 'demo', false), {
      code: 'E_PATH',
    })
  })

  test('allows optional files only when opted in', () => {
    assert.equal(
      validateSyncPath('profiles/demo/pnpm-lock.yaml', 'demo', true),
      'profiles/demo/pnpm-lock.yaml',
    )
    assert.equal(
      validateSyncPath('profiles/demo/pnpm-workspace.yaml', 'demo', false, true),
      'profiles/demo/pnpm-workspace.yaml',
    )
    assert.throws(() => validateSyncPath('profiles/demo/pnpm-workspace.yaml', 'demo', false), {
      code: 'E_PATH',
    })
  })
})

describe('changedFiles', () => {
  test('compares plain hash tables and manifest entries', () => {
    const previous = { 'profiles/demo/package.json': 'aaa', 'profiles/demo/pnpm-lock.yaml': 'bbb' }
    const current = {
      'profiles/demo/package.json': { sha256: 'aaa' },
      'profiles/demo/cordis.patch.yml': { sha256: 'ccc' },
    }
    assert.deepEqual(changedFiles(previous, current), [
      'profiles/demo/cordis.patch.yml',
      'profiles/demo/pnpm-lock.yaml',
    ])
  })

  test('restricts comparison to managed paths', () => {
    const previous = { 'profiles/demo/package.json': 'aaa', 'profiles/demo/pnpm-lock.yaml': 'bbb' }
    const current = { 'profiles/demo/package.json': 'aaa' }
    const managed = new Set(['profiles/demo/package.json'])
    assert.deepEqual(changedFiles(previous, current, managed), [])
  })
})

describe('diffManifests', () => {
  function manifest(profile, entries, plugins = {}) {
    return {
      schemaVersion: 1,
      profile,
      files: Object.fromEntries(
        Object.entries(entries).map(([path, sha]) => [path, { sha256: sha, size: 1 }]),
      ),
      plugins: { bundles: [], dependencies: {}, ...plugins },
    }
  }

  test('reports added, modified and removed files', () => {
    const local = manifest('demo', {
      'profiles/demo/package.json': 'aaa',
      'profiles/demo/pnpm-lock.yaml': 'ccc',
    })
    const remote = manifest('demo', {
      'profiles/demo/package.json': 'bbb',
      'profiles/demo/cordis.patch.yml': 'ddd',
    })
    const diff = diffManifests(local, remote)
    assert.deepEqual(
      diff.fileChanges.map((item) => [item.status, item.path]),
      [
        ['added', 'profiles/demo/cordis.patch.yml'],
        ['modified', 'profiles/demo/package.json'],
        ['removed', 'profiles/demo/pnpm-lock.yaml'],
      ],
    )
    assert.equal(diff.hasChanges, true)
  })

  test('reports plugin additions, removals and version changes', () => {
    const local = manifest('demo', {}, { dependencies: { a: '1.0.0', b: '1.0.0', local: 'link:../x' } })
    const remote = manifest('demo', {}, { dependencies: { b: '2.0.0', c: '3.0.0' } })
    const diff = diffManifests(local, remote)
    assert.deepEqual(diff.plugins.added, [{ name: 'c', version: '3.0.0' }])
    assert.deepEqual(diff.plugins.removed, [
      { name: 'a', version: '1.0.0' },
      { name: 'local', version: 'link:../x' },
    ])
    assert.deepEqual(diff.plugins.changed, [{ name: 'b', from: '1.0.0', to: '2.0.0' }])
    assert.deepEqual(diff.plugins.manual, [])
  })

  test('flags link/file plugins as manual to install', () => {
    const local = manifest('demo', {}, { dependencies: { local: 'link:../old' } })
    const remote = manifest('demo', {}, { dependencies: { local: 'link:../new', fresh: 'file:../f' } })
    const diff = diffManifests(local, remote)
    assert.deepEqual(diff.plugins.manual.sort(), ['fresh', 'local'])
  })

  test('reports no changes for identical manifests', () => {
    const local = manifest('demo', { 'profiles/demo/package.json': 'aaa' })
    const diff = diffManifests(local, local)
    assert.equal(diff.hasChanges, false)
    assert.match(summarizeDiff(diff), /No differences/)
  })
})

describe('dependencyVersion', () => {
  test('keeps specs verbatim and normalizes blanks', () => {
    assert.equal(dependencyVersion('^1.2.3'), '^1.2.3')
    assert.equal(dependencyVersion('link:../x'), 'link:../x')
    assert.equal(dependencyVersion(''), 'unknown')
    assert.equal(dependencyVersion(undefined), 'unknown')
  })
})

describe('manifestPath', () => {
  test('lives next to the profile files', () => {
    assert.equal(manifestPath('demo'), 'profiles/demo/manifest.json')
  })
})
