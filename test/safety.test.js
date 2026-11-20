import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  DELETABLE,
  PROTECTED_ENTRIES,
  assertDeletable,
  assertProfileWritable,
  assertRemoteManifestPlausible,
  detectUnmanagedRemoval,
  hasUnmanagedContent,
  listProfileEntries,
  plannedDeletions,
  snapshotAlways,
} from '../src/safety.js'
import { SyncError } from '../src/errors.js'

const tempDirs = []

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-safety-'))
  tempDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('assertDeletable', () => {
  test('accepts every managed file name', () => {
    for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      assert.equal(assertDeletable(name), name)
    }
  })

  test('refuses paths and directory names with E_DELETE_REFUSED', () => {
    for (const name of [
      'node_modules',
      '.plugin-manager',
      'cordis.yml',
      'package.json.bak',
      '../package.json',
      'profiles/desktop',
      'sub/package.json',
      '',
      '.',
      '..',
    ]) {
      assert.throws(() => assertDeletable(name), (error) => {
        assert.ok(error instanceof SyncError)
        assert.equal(error.code, 'E_DELETE_REFUSED')
        return true
      })
    }
  })

  test('the allowlist never covers protected directory entries', () => {
    for (const name of PROTECTED_ENTRIES) {
      assert.ok(!DELETABLE.has(name), `${name} must not be deletable`)
    }
  })
})

describe('assertProfileWritable', () => {
  test('passes when package.json exists and is a file', async () => {
    const dir = await makeHome()
    await writeFile(join(dir, 'package.json'), '{}')
    await assert.doesNotReject(assertProfileWritable(dir))
  })

  test('refuses with E_PROFILE_EMPTY when package.json is missing', async () => {
    const dir = await makeHome()
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await assert.rejects(assertProfileWritable(dir), (error) => {
      assert.ok(error instanceof SyncError)
      assert.equal(error.code, 'E_PROFILE_EMPTY')
      assert.match(error.message, /no readable package\.json/)
      return true
    })
  })

  test('refuses when package.json is a directory', async () => {
    const dir = await makeHome()
    await mkdir(join(dir, 'package.json'), { recursive: true })
    await assert.rejects(assertProfileWritable(dir), (error) => {
      assert.equal(error.code, 'E_PROFILE_EMPTY')
      return true
    })
  })
})

describe('assertRemoteManifestPlausible', () => {
  test('accepts a manifest that references package.json', () => {
    assert.doesNotThrow(() =>
      assertRemoteManifestPlausible(
        { profile: 'desktop', files: { 'profiles/desktop/package.json': { sha256: 'a'.repeat(64) } } },
        'desktop',
      ),
    )
  })

  test('refuses an empty files map with E_REMOTE_EMPTY_MANIFEST', () => {
    assert.throws(
      () => assertRemoteManifestPlausible({ profile: 'desktop', files: {} }, 'desktop'),
      (error) => {
        assert.ok(error instanceof SyncError)
        assert.equal(error.code, 'E_REMOTE_EMPTY_MANIFEST')
        return true
      },
    )
  })

  test('refuses a manifest without files at all', () => {
    assert.throws(() => assertRemoteManifestPlausible(null, 'desktop'), (error) => {
      assert.equal(error.code, 'E_REMOTE_EMPTY_MANIFEST')
      return true
    })
  })

  test('refuses a manifest missing the channel package.json', () => {
    assert.throws(
      () =>
        assertRemoteManifestPlausible(
          { profile: 'desktop', files: { 'profiles/other/package.json': { sha256: 'a'.repeat(64) } } },
          'desktop',
        ),
      (error) => {
        assert.equal(error.code, 'E_REMOTE_EMPTY_MANIFEST')
        return true
      },
    )
  })

  test('refuses manifest paths outside the allowlist', () => {
    assert.throws(
      () =>
        assertRemoteManifestPlausible(
          {
            profile: 'desktop',
            files: {
              'profiles/desktop/package.json': { sha256: 'a'.repeat(64) },
              'profiles/desktop/../evil': { sha256: 'b'.repeat(64) },
            },
          },
          'desktop',
        ),
      (error) => {
        assert.ok(error instanceof SyncError)
        assert.equal(error.code, 'E_PATH')
        return true
      },
    )
  })
})

describe('listProfileEntries / hasUnmanagedContent / detectUnmanagedRemoval', () => {
  test('lists top-level entries with their kind', async () => {
    const dir = await makeHome()
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}')
    const entries = await listProfileEntries(dir)
    assert.deepEqual(
      entries.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'node_modules', kind: 'dir' },
        { name: 'package.json', kind: 'file' },
      ],
    )
    assert.equal(hasUnmanagedContent(entries), true)
  })

  test('a missing directory lists as empty and never throws', async () => {
    const entries = await listProfileEntries(join(await makeHome(), 'missing'))
    assert.deepEqual(entries, [])
    assert.equal(hasUnmanagedContent(entries), false)
  })

  test('detects unmanaged entries that disappeared', () => {
    const before = [
      { name: 'node_modules', kind: 'dir' },
      { name: '.plugin-manager', kind: 'dir' },
      { name: 'package.json', kind: 'file' },
      { name: 'cordis.patch.yml', kind: 'file' },
    ]
    const after = [
      { name: 'package.json', kind: 'file' },
      { name: 'cordis.patch.yml', kind: 'file' },
    ]
    assert.deepEqual(detectUnmanagedRemoval(before, after), ['.plugin-manager', 'node_modules'])
  })

  test('managed files disappearing are not reported', () => {
    const before = [
      { name: 'package.json', kind: 'file' },
      { name: 'pnpm-lock.yaml', kind: 'file' },
    ]
    const after = [{ name: 'package.json', kind: 'file' }]
    assert.deepEqual(detectUnmanagedRemoval(before, after), [])
  })

  test('added entries are not removals', () => {
    const before = [{ name: 'package.json', kind: 'file' }]
    const after = [
      { name: 'package.json', kind: 'file' },
      { name: 'node_modules', kind: 'dir' },
    ]
    assert.deepEqual(detectUnmanagedRemoval(before, after), [])
  })
})

describe('plannedDeletions / snapshotAlways', () => {
  test('names owned files the remote no longer carries', () => {
    const deletions = plannedDeletions({
      allowedNames: ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
      syncedFiles: new Map([['profiles/desktop/package.json', Buffer.from('{}')]]),
      owned: new Set([
        'profiles/desktop/package.json',
        'profiles/desktop/cordis.patch.yml',
        'profiles/desktop/pnpm-lock.yaml',
      ]),
      channel: 'desktop',
    })
    assert.deepEqual(deletions, ['cordis.patch.yml', 'pnpm-lock.yaml'])
  })

  test('no deletions when the remote still carries every owned file', () => {
    const deletions = plannedDeletions({
      allowedNames: ['package.json', 'cordis.patch.yml'],
      syncedFiles: new Map([
        ['profiles/desktop/package.json', Buffer.from('{}')],
        ['profiles/desktop/cordis.patch.yml', Buffer.from('[]')],
      ]),
      owned: new Set(['profiles/desktop/package.json', 'profiles/desktop/cordis.patch.yml']),
      channel: 'desktop',
    })
    assert.deepEqual(deletions, [])
  })

  test('a destructive pull snapshots even when snapshotting is off', () => {
    const ctx = { config: { snapshot: false } }
    assert.equal(snapshotAlways(ctx, ['cordis.patch.yml'], false), true)
    assert.equal(snapshotAlways(ctx, [], false), false)
    assert.equal(snapshotAlways(ctx, ['cordis.patch.yml'], true), false)
    assert.equal(snapshotAlways({ config: { snapshot: true } }, [], false), false)
  })
})
