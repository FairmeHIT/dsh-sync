import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { normalizeConfig } from '../src/config.js'
import {
  compareVersions,
  parseGitHubSource,
  readUpdateState,
  resolveCommit,
  startUpdate,
  updateStatePath,
  checkUpdate,
  createManagerProbe,
} from '../src/update.js'

const SHA = 'e9b312ddd95031ab1f84485a5c4764789ae36acf'
const FULL_SHA = '0123456789abcdef0123456789abcdef01234567'

async function home(t, { spec = `github:FairmeHIT/dsh-sync#${SHA}`, profile = 'demo' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'profiles', profile)
  await mkdir(dir, { recursive: true })
  const pkg = {
    name: `dsh-profile-${profile}`,
    private: true,
    ...(spec === null ? {} : { dependencies: { 'dsh-config-git-sync': spec } }),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-config-git-sync'] } },
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  return normalizeConfig({ dshHome: root, profile, branch: 'main' })
}

describe('parseGitHubSource', () => {
  test('reads the GitHub shorthand and defaults to main', () => {
    assert.deepEqual(parseGitHubSource('github:FairmeHIT/dsh-sync'), {
      owner: 'FairmeHIT',
      repo: 'dsh-sync',
      ref: '',
      commit: '',
      branch: 'main',
    })
  })

  test('keeps a branch ref and detects a full commit pin', () => {
    assert.equal(parseGitHubSource('github:o/r#next').branch, 'next')
    const pinned = parseGitHubSource(`github:o/r#${FULL_SHA}`)
    assert.equal(pinned.commit, FULL_SHA)
    // A pinned commit still reads the default branch for the published version:
    // the pin is where the install came from, not what the repository releases.
    assert.equal(pinned.branch, 'main')
  })

  test('accepts https, git+https and ssh spellings', () => {
    for (const spec of [
      'https://github.com/o/r.git',
      'git+https://github.com/o/r.git',
      'git@github.com:o/r.git',
      'ssh://git@github.com/o/r.git',
      'https://github.com/o/r',
    ]) {
      const parsed = parseGitHubSource(spec)
      assert.ok(parsed, spec)
      assert.deepEqual([parsed.owner, parsed.repo, parsed.branch], ['o', 'r', 'main'], spec)
    }
    assert.equal(parseGitHubSource('git@github.com:o/r.git#dev').branch, 'dev')
  })

  test('refuses anything that is not a GitHub spec', () => {
    for (const spec of [
      '',
      null,
      undefined,
      'dsh-config-git-sync',
      'file:D:/tmp/dsh-sync.tgz',
      'link:D:/code/dsh-sync',
      'D:\\code\\dsh-sync',
      'https://gitlab.com/o/r.git',
      'github:FakeHIT', // a bare org is not a repository
    ]) {
      assert.equal(parseGitHubSource(spec), null, String(spec))
    }
  })
})

describe('compareVersions', () => {
  test('orders releases numerically, not lexically', () => {
    assert.equal(compareVersions('0.7.2', '0.7.3'), -1)
    assert.equal(compareVersions('0.7.10', '0.7.9'), 1)
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
    assert.equal(compareVersions('v0.7.2', '0.7.2'), 0)
    assert.equal(compareVersions('0.7', '0.7.0'), 0)
    assert.equal(compareVersions('0.7.2+build.5', '0.7.2'), 0)
  })

  test('sorts a prerelease before its release', () => {
    assert.equal(compareVersions('0.8.0-rc.1', '0.8.0'), -1)
    assert.equal(compareVersions('0.8.0', '0.8.0-rc.1'), 1)
    assert.equal(compareVersions('0.8.0-rc.1', '0.8.0-rc.1'), 0)
  })
})

describe('checkUpdate', () => {
  test('reports the published version as available over a branch install', async (t) => {
    const config = await home(t, { spec: 'github:FairmeHIT/dsh-sync' })
    const state = await checkUpdate(config, {
      currentVersion: '0.7.2',
      remoteVersion: async () => '0.7.3',
    })
    assert.equal(state.ok, true)
    assert.equal(state.supported, true)
    assert.equal(state.current, '0.7.2')
    assert.equal(state.latest, '0.7.3')
    assert.equal(state.available, true)
    assert.equal(state.repo, 'FairmeHIT/dsh-sync')
    assert.equal(state.branch, 'main')
    // A branch spec is installed over; only a pinned commit can be replaced by
    // the manager with rollback.
    assert.equal(state.mode, 'install')
  })

  test('reads a pinned install as replaceable and an equal version as current', async (t) => {
    const config = await home(t, { spec: `github:FairmeHIT/dsh-sync#${SHA}` })
    const pinned = await checkUpdate(config, { currentVersion: '0.7.2', remoteVersion: async () => '0.7.3' })
    assert.equal(pinned.mode, 'update')
    const same = await checkUpdate(config, { currentVersion: '0.7.3', remoteVersion: async () => '0.7.3' })
    assert.equal(same.available, false)
    assert.equal(same.latest, '0.7.3')
  })

  test('explains a local install instead of offering an update', async (t) => {
    for (const spec of ['file:D:/tmp/x.tgz', 'link:D:/code/dsh-sync', 'D:\\code\\dsh-sync']) {
      const config = await home(t, { spec })
      const state = await checkUpdate(config, { currentVersion: '0.7.2', remoteVersion: async () => '9.9.9' })
      assert.equal(state.supported, false, spec)
      assert.equal(state.reason, 'local-install', spec)
      assert.equal(state.current, '0.7.2')
    }
  })

  test('explains a non-GitHub install and a missing dependency', async (t) => {
    const other = await home(t, { spec: 'https://gitlab.com/o/r.git' })
    assert.equal((await checkUpdate(other, { currentVersion: '0.7.2' })).reason, 'not-github')
    const none = await home(t, { spec: null })
    assert.equal((await checkUpdate(none, { currentVersion: '0.7.2' })).reason, 'no-source')
  })

  test('a failing version read keeps the row usable and reports the reason', async (t) => {
    const config = await home(t)
    const state = await checkUpdate(config, {
      currentVersion: '0.7.2',
      remoteVersion: async () => {
        throw new Error('offline')
      },
    })
    assert.equal(state.supported, true)
    assert.equal(state.available, false)
    assert.equal(state.latest, null)
    assert.match(state.error, /offline/)
  })

  test('an unreadable profile manifest is not reported as up to date', async (t) => {
    const config = normalizeConfig({ dshHome: join(tmpdir(), 'dsh-sync-update-missing'), profile: 'demo' })
    const state = await checkUpdate(config, { currentVersion: '0.7.2' })
    assert.equal(state.ok, true)
    assert.equal(state.supported, false)
    assert.equal(state.reason, 'no-manifest')
  })
})

describe('createManagerProbe', () => {
  test('finds a manager on the connection scope when the outer context has none', () => {
    const manager = { installBundle: async () => ({}) }
    const scope = { get: (name) => (name === 'pluginManager' ? manager : undefined) }
    const ctx = { get: () => undefined, inject: () => assert.fail('must not start a service that is already visible') }
    const probe = createManagerProbe(ctx, { context: scope })
    assert.equal(probe.get(), manager)
  })

  test('starts the lazy service through Cordis and keeps the context that saw it', async () => {
    const manager = { installBundle: async () => ({}) }
    let offered = null
    const ctx = {
      get: () => undefined,
      inject: (names, callback) => {
        assert.deepEqual(names, ['pluginManager'])
        offered = { get: (name) => (name === 'pluginManager' ? manager : undefined) }
        callback(offered)
      },
    }
    const probe = createManagerProbe(ctx, {})
    assert.equal(probe.get(), undefined)
    assert.equal(await probe.ensure(), manager)
    // Later reads answer without another start attempt.
    assert.equal(probe.get(), manager)
  })

  test('gives up on the deadline instead of hanging when the service never arrives', async () => {
    const ctx = { get: () => undefined, inject: () => {} }
    const probe = createManagerProbe(ctx, { timeoutMs: 20 })
    assert.equal(await probe.ensure(), undefined)
  })

  test('ignores a service without installBundle', async () => {
    const ctx = { get: () => ({ readBundleDetail: () => {} }), inject: () => assert.fail('must not start') }
    const probe = createManagerProbe(ctx, {})
    assert.equal(probe.get(), undefined)
  })
})

describe('the published version read', () => {
  test('falls back to a mirror when raw.githubusercontent is unreachable', async (t) => {
    const config = await home(t, { spec: 'github:FairmeHIT/dsh-sync' })
    const tried = []
    const state = await checkUpdate(config, {
      currentVersion: '0.7.3',
      fetchText: async (url) => {
        tried.push(url)
        if (url.includes('raw.githubusercontent.com')) throw new Error('fetch failed')
        return JSON.stringify({ name: 'dsh-config-git-sync', version: '0.7.4' })
      },
    })
    assert.equal(state.latest, '0.7.4')
    assert.equal(state.available, true)
    assert.equal(tried.length, 2, `stopped at the first answer: ${tried.join(' ')}`)
    assert.match(tried[1], /jsdelivr/)
  })

  test('reports every source it tried when none of them answers', async (t) => {
    const config = await home(t, { spec: 'github:FairmeHIT/dsh-sync' })
    const state = await checkUpdate(config, {
      currentVersion: '0.7.3',
      fetchText: async () => {
        throw new Error('offline')
      },
    })
    assert.equal(state.latest, null)
    assert.equal(state.available, false)
    assert.match(state.error, /tried 4 sources/)
    assert.match(state.error, /raw\.githubusercontent\.com/)
    assert.match(state.error, /jsdelivr/)
  })

  test('moves on when a source answers with something that is not JSON', async (t) => {
    const config = await home(t, { spec: 'github:FairmeHIT/dsh-sync' })
    const state = await checkUpdate(config, {
      currentVersion: '0.7.3',
      fetchText: async (url) =>
        url.includes('raw.githubusercontent.com') ? '<html>blocked</html>' : JSON.stringify({ version: '0.7.4' }),
    })
    assert.equal(state.latest, '0.7.4')
  })
})

describe('resolveCommit', () => {
  test('turns refs/heads output into a full sha', async () => {
    const sha = await resolveCommit(
      { owner: 'o', repo: 'r', branch: 'main' },
      { runGit: async () => `  ${SHA.toUpperCase()}\trefs/heads/main\n` },
    )
    assert.equal(sha, SHA)
  })

  test('refuses output that is not a full commit', async () => {
    await assert.rejects(
      () => resolveCommit({ owner: 'o', repo: 'r', branch: 'main' }, { runGit: async () => 'e9b312d\trefs/heads/main' }),
      /cannot resolve main in o\/r/,
    )
    await assert.rejects(
      () => resolveCommit({ owner: 'o', repo: 'r', branch: 'main' }, { runGit: async () => '' }),
      /cannot resolve/,
    )
  })
})

describe('the update state file', () => {
  test('is absent before the first attempt and survives a corrupt write', async (t) => {
    const config = await home(t)
    assert.equal(await readUpdateState(config), null)
    await mkdir(join(config.dshHome, 'config-sync'), { recursive: true })
    await writeFile(updateStatePath(config), '{"schemaVersion":1,')
    assert.equal(await readUpdateState(config), null)
  })

  test('reports an interrupted run as failed instead of running forever', async (t) => {
    const config = await home(t)
    await mkdir(join(config.dshHome, 'config-sync'), { recursive: true })
    const started = new Date(Date.now() - 10 * 60_000).toISOString()
    await writeFile(
      updateStatePath(config),
      JSON.stringify({ schemaVersion: 1, status: 'running', from: '0.7.2', to: '0.7.3', startedAt: started }),
    )
    const stale = await readUpdateState(config)
    assert.equal(stale.status, 'failed')
    assert.match(stale.message, /did not finish/)

    await writeFile(
      updateStatePath(config),
      JSON.stringify({ schemaVersion: 1, status: 'running', from: '0.7.2', to: '0.7.3', startedAt: new Date().toISOString() }),
    )
    assert.equal((await readUpdateState(config)).status, 'running')
  })
})

describe('startUpdate', () => {
  test('refuses without a plugin manager', async (t) => {
    const config = await home(t)
    await assert.rejects(() => startUpdate(config, {}), /plugin manager/)
  })

  test('starts the lazy manager instead of failing on the first read', async (t) => {
    const config = await home(t, { spec: 'github:FairmeHIT/dsh-sync' })
    let started = 0
    const result = await startUpdate(config, {
      currentVersion: '0.7.2',
      immediate: true,
      remoteVersion: async () => '0.7.3',
      runGit: async () => `${FULL_SHA}\trefs/heads/main\n`,
      getManager: () => undefined,
      ensureManager: async () => {
        started += 1
        return { installBundle: async () => ({ result: { application: 'applied' } }) }
      },
    })
    assert.equal(started, 1)
    assert.equal(result.to, '0.7.3')
    await result.settled
    assert.equal((await readUpdateState(config)).status, 'done')
  })

  test('refuses a local install, a non-GitHub install and a current version', async (t) => {
    const local = await home(t, { spec: 'link:D:/code/dsh-sync' })
    const manager = { installBundle: async () => ({}) }
    await assert.rejects(
      () => startUpdate(local, { getManager: () => manager, currentVersion: '0.7.2' }),
      /installed from a local path/,
    )
    const other = await home(t, { spec: 'https://gitlab.com/o/r.git' })
    await assert.rejects(
      () => startUpdate(other, { getManager: () => manager, currentVersion: '0.7.2' }),
      /not installed from GitHub/,
    )
    const current = await home(t)
    await assert.rejects(
      () =>
        startUpdate(current, {
          getManager: () => manager,
          currentVersion: '0.7.3',
          remoteVersion: async () => '0.7.3',
        }),
      /already on the newest version/,
    )
  })

  test('installs a pinned commit over a branch install and records the outcome', async (t) => {
    const config = await home(t, { spec: 'github:FairmeHIT/dsh-sync' })
    const seen = []
    const manager = {
      installBundle: async (spec, options) => {
        seen.push({ spec, options })
        return { changed: true, result: { application: 'applied' } }
      },
    }
    const result = await startUpdate(config, {
      getManager: () => manager,
      immediate: true,
      currentVersion: '0.7.2',
      remoteVersion: async () => '0.7.3',
      resolveCommit: async () => FULL_SHA,
    })
    assert.equal(result.from, '0.7.2')
    assert.equal(result.to, '0.7.3')
    await result.settled
    assert.deepEqual(seen, [
      {
        spec: `github:FairmeHIT/dsh-sync#${FULL_SHA}`,
        options: { expected: { name: 'dsh-config-git-sync', version: '0.7.3' } },
      },
    ])
    const state = await readUpdateState(config)
    assert.equal(state.status, 'done')
    assert.equal(state.from, '0.7.2')
    assert.equal(state.to, '0.7.3')
    assert.equal(state.application, 'applied')
  })

  test('replaces a pinned install through the manager so a failure rolls back', async (t) => {
    const config = await home(t, { spec: `github:FairmeHIT/dsh-sync#${SHA}` })
    const seen = []
    const manager = {
      installBundle: async () => assert.fail('a pinned install must go through updateBundle'),
      updateBundle: async (name, version, options) => {
        seen.push({ name, version, options })
        return { result: { application: 'restart-required' } }
      },
    }
    const result = await startUpdate(config, {
      getManager: () => manager,
      immediate: true,
      currentVersion: '0.7.2',
      remoteVersion: async () => '0.7.3',
      resolveCommit: async () => FULL_SHA,
    })
    await result.settled
    assert.deepEqual(seen, [
      { name: 'dsh-config-git-sync', version: '0.7.3', options: { spec: `github:FairmeHIT/dsh-sync#${FULL_SHA}` } },
    ])
    const state = await readUpdateState(config)
    assert.equal(state.status, 'done')
    assert.equal(state.application, 'restart-required')
  })

  test('records a refused installation as failed with its reason', async (t) => {
    const config = await home(t)
    const manager = {
      installBundle: async () => ({
        changed: false,
        result: { application: 'unchanged', error: { code: 'E_BUILD', diagnostic: 'build approval required' } },
      }),
    }
    const result = await startUpdate(config, {
      getManager: () => manager,
      immediate: true,
      currentVersion: '0.7.2',
      remoteVersion: async () => '0.7.3',
      resolveCommit: async () => FULL_SHA,
    })
    assert.equal((await result.settled).ok, false)
    const state = await readUpdateState(config)
    assert.equal(state.status, 'failed')
    assert.match(state.message, /build approval required/)
  })

  test('records a thrown installation failure instead of leaving it running', async (t) => {
    const config = await home(t)
    const manager = {
      installBundle: async () => {
        throw new Error('pnpm exited 1')
      },
    }
    const result = await startUpdate(config, {
      getManager: () => manager,
      immediate: true,
      currentVersion: '0.7.2',
      remoteVersion: async () => '0.7.3',
      resolveCommit: async () => FULL_SHA,
    })
    assert.equal((await result.settled).ok, false)
    const state = await readUpdateState(config)
    assert.equal(state.status, 'failed')
    assert.match(state.message, /pnpm exited 1/)
  })

  test('answers before it installs so the request is not unloaded mid-flight', async (t) => {
    const config = await home(t)
    const manager = {
      installBundle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { result: { application: 'applied' } }
      },
    }
    const result = await startUpdate(config, {
      getManager: () => manager,
      currentVersion: '0.7.2',
      remoteVersion: async () => '0.7.3',
      resolveCommit: async () => FULL_SHA,
    })
    // The acceptance carries the plan; the install is still pending.
    assert.equal(result.to, '0.7.3')
    assert.equal((await readUpdateState(config)).status, 'running')
    await result.settled
    assert.equal((await readUpdateState(config)).status, 'done')
  })
})

test('the state file lives under the config-sync directory beside activity.json', async (t) => {
  const config = await home(t)
  assert.equal(updateStatePath(config), join(config.dshHome, 'config-sync', 'update.json'))
  await startUpdate(config, {
    getManager: () => ({ installBundle: async () => ({ result: { application: 'applied' } }) }),
    immediate: true,
    currentVersion: '0.7.2',
    remoteVersion: async () => '0.7.3',
    resolveCommit: async () => FULL_SHA,
  }).then((result) => result.settled)
  // Written by the very module under test, not by the test's own fixture.
  const raw = JSON.parse(await readFile(updateStatePath(config), 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.spec, `github:FairmeHIT/dsh-sync#${FULL_SHA}`)
})
