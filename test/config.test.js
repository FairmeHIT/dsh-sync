import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  Config,
  PACKAGE_NAME,
  normalizeConfig,
  requireBranch,
  requireRemote,
  resolveDshHome,
} from '../src/config.js'

const DEFAULTS = {
  remote: '',
  branch: 'main',
  profile: '',
  dshHome: '',
  includeLockfile: false,
  includeWorkspace: false,
  reconcile: 'install',
  snapshot: true,
  snapshotKeep: 20,
  secretScan: 'warn',
  gitBin: 'git',
  authorName: 'dsh-config-git-sync',
  authorEmail: 'dsh-config-git-sync@localhost',
}

describe('Config schema', () => {
  test('fills documented defaults', () => {
    const value = Config({})
    assert.equal(value.remote, '')
    assert.equal(value.branch, 'main')
    assert.equal(value.profile, '')
    assert.equal(value.dshHome, '')
    assert.equal(value.includeLockfile, false)
    assert.equal(value.includeWorkspace, false)
    assert.equal(value.reconcile, 'install')
    assert.equal(value.snapshot, true)
    assert.equal(value.snapshotKeep, 20)
    assert.equal(value.secretScan, 'warn')
    assert.equal(value.gitBin, 'git')
    assert.equal(value.authorName, 'dsh-config-git-sync')
    assert.equal(value.authorEmail, 'dsh-config-git-sync@localhost')
  })

  test('accepts explicit values', () => {
    const value = Config({
      remote: 'git@github.com:me/dsh-config.git',
      branch: 'config',
      profile: 'desktop',
      includeLockfile: true,
      includeWorkspace: true,
      reconcile: 'none',
      snapshotKeep: 5,
      secretScan: 'off',
    })
    assert.equal(value.remote, 'git@github.com:me/dsh-config.git')
    assert.equal(value.branch, 'config')
    assert.equal(value.reconcile, 'none')
    assert.equal(value.includeWorkspace, true)
    assert.equal(value.snapshotKeep, 5)
    assert.equal(value.secretScan, 'off')
  })

  test('rejects an unknown reconcile mode and secret scan mode', () => {
    assert.throws(() => Config({ reconcile: 'always' }))
    assert.throws(() => Config({ secretScan: 'block' }))
  })
})

describe('normalizeConfig', () => {
  test('defaults an empty input', () => {
    assert.deepEqual(normalizeConfig(), DEFAULTS)
  })

  test('trims strings and restores empty branch', () => {
    const value = normalizeConfig({ remote: '  git@example.com:me/repo.git  ', branch: '  ', profile: ' desktop ' })
    assert.equal(value.remote, 'git@example.com:me/repo.git')
    assert.equal(value.branch, 'main')
    assert.equal(value.profile, 'desktop')
  })

  test('only the literal false disables snapshot and only true enables optional files', () => {
    assert.equal(normalizeConfig({ snapshot: false }).snapshot, false)
    assert.equal(normalizeConfig({ snapshot: 'no' }).snapshot, true)
    assert.equal(normalizeConfig({ includeLockfile: true }).includeLockfile, true)
    assert.equal(normalizeConfig({ includeLockfile: 'true' }).includeLockfile, false)
    assert.equal(normalizeConfig({ includeWorkspace: true }).includeWorkspace, true)
    assert.equal(normalizeConfig({ includeWorkspace: 1 }).includeWorkspace, false)
  })

  test('keeps only the known reconcile and secret-scan modes', () => {
    assert.equal(normalizeConfig({ reconcile: 'none' }).reconcile, 'none')
    assert.equal(normalizeConfig({ reconcile: 'install' }).reconcile, 'install')
    assert.equal(normalizeConfig({}).reconcile, 'install')
    assert.equal(normalizeConfig({ reconcile: 'something' }).reconcile, 'install')
    assert.equal(normalizeConfig({ secretScan: 'off' }).secretScan, 'off')
    assert.equal(normalizeConfig({ secretScan: 'block' }).secretScan, 'warn')
  })

  test('normalizes snapshot retention', () => {
    assert.equal(normalizeConfig({ snapshotKeep: 5 }).snapshotKeep, 5)
    assert.equal(normalizeConfig({ snapshotKeep: '5' }).snapshotKeep, 5)
    assert.equal(normalizeConfig({ snapshotKeep: 3.9 }).snapshotKeep, 3)
    assert.equal(normalizeConfig({ snapshotKeep: -1 }).snapshotKeep, 20)
    assert.equal(normalizeConfig({ snapshotKeep: 'many' }).snapshotKeep, 20)
    assert.equal(normalizeConfig({ snapshotKeep: 0 }).snapshotKeep, 0)
  })

  test('falls back to usable author and git values', () => {
    const value = normalizeConfig({ gitBin: '   ', authorName: ' ', authorEmail: '' })
    assert.equal(value.gitBin, 'git')
    assert.equal(value.authorName, 'dsh-config-git-sync')
    assert.equal(value.authorEmail, 'dsh-config-git-sync@localhost')
  })

  test('ignores unknown keys instead of leaking them', () => {
    const value = normalizeConfig({ remote: 'x', nested: { secret: true }, surprise: 1 })
    assert.deepEqual(Object.keys(value).sort(), Object.keys(DEFAULTS).sort())
    assert.equal(value.remote, 'x')
  })
})

describe('resolveDshHome', () => {
  test('prefers an explicit dshHome and expands ~', () => {
    const value = resolveDshHome({ dshHome: '~/custom-dsh' })
    assert.equal(value, join(homedir(), 'custom-dsh'))
  })

  test('expands a bare ~ to the home directory', () => {
    assert.equal(resolveDshHome({ dshHome: '~' }), homedir())
  })

  test('falls back to DSH_HOME', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = 'C:\\dsh-home-test'
    try {
      assert.equal(resolveDshHome({ dshHome: '' }), 'C:\\dsh-home-test')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  test('falls back to ~/.dsh', () => {
    const previous = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      assert.equal(resolveDshHome({ dshHome: '' }), join(homedir(), '.dsh'))
    } finally {
      if (previous !== undefined) process.env.DSH_HOME = previous
    }
  })
})

describe('requireRemote', () => {
  test('rejects an empty remote with E_CONFIG', () => {
    assert.throws(() => requireRemote({ remote: '' }), { code: 'E_CONFIG' })
  })

  test('returns a configured remote', () => {
    assert.equal(requireRemote({ remote: 'git@example.com:me/repo.git' }), 'git@example.com:me/repo.git')
  })
})

describe('requireBranch', () => {
  test('accepts ordinary local and hierarchical branch names', () => {
    for (const branch of ['main', 'config', 'release-1.2', 'feature/sync', 'team/a_b.c']) {
      assert.equal(requireBranch({ branch }), branch)
    }
  })

  test('rejects branch names that are unsafe in refspecs or paths', () => {
    for (const branch of ['', 'a b', '-force', 'a..b', 'a//b', 'a/../b', 'x.lock', 'a.lock/b', 'x/', '.hidden', 'a\\b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', '@{upstream}']) {
      if (branch === '') {
        assert.equal(requireBranch({ branch }), 'main')
        continue
      }
      assert.throws(() => requireBranch({ branch }), { code: 'E_CONFIG' }, branch)
    }
  })
})

test('exports the published package name', () => {
  assert.equal(PACKAGE_NAME, 'dsh-config-git-sync')
})
