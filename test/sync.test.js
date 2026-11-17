import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { normalizeConfig } from '../src/config.js'
import {
  PACKAGE_NAME,
  isMissingCommand,
  packageManagerOrder,
  reconcilePackages,
  resolveContext,
} from '../src/sync.js'

const tempDirs = []

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-sync-'))
  tempDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('packageManagerOrder', () => {
  test('prefers pnpm and falls back through corepack to npm', () => {
    assert.deepEqual(packageManagerOrder({}), ['pnpm', 'corepack', 'npm'])
    assert.deepEqual(packageManagerOrder({ pnpmLock: true }), ['pnpm', 'corepack', 'npm'])
    assert.deepEqual(packageManagerOrder({ pnpmLock: true, npmLock: true }), ['pnpm', 'corepack', 'npm'])
  })

  test('uses npm when the profile is npm-managed', () => {
    assert.deepEqual(packageManagerOrder({ npmLock: true }), ['npm'])
  })
})

describe('reconcilePackages', () => {
  test('skips installation when reconcile is none', async () => {
    const result = await reconcilePackages({
      config: { reconcile: 'none' },
      profileDir: 'C:\\missing',
    })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, true)
  })

  test('defaults to none so a pulled manifest cannot run package scripts', () => {
    assert.equal(normalizeConfig({}).reconcile, 'none')
  })
})

describe('isMissingCommand', () => {
  test('recognizes a missing package-manager binary', () => {
    assert.equal(isMissingCommand({ spawnCode: 'ENOENT', output: '' }), true)
    assert.equal(
      isMissingCommand({
        spawnCode: null,
        output: "'pnpm' is not recognized as an internal or external command",
      }),
      true,
    )
    assert.equal(
      isMissingCommand({ spawnCode: null, output: 'pnpm: 不是内部或外部命令' }),
      true,
    )
  })

  test('does not mask a real install failure as a missing binary', () => {
    assert.equal(
      isMissingCommand({
        spawnCode: null,
        output: 'ERR_PNPM_NO_MATCHING_VERSION No matching version found for left-pad@9',
      }),
      false,
    )
    assert.equal(
      isMissingCommand({
        spawnCode: null,
        output: 'ENOENT: no such file or directory, open link-target',
      }),
      false,
    )
  })
})

describe('resolveContext', () => {
  test('returns the explicit profile and validated branch', async () => {
    const home = await makeHome()
    const config = normalizeConfig({
      remote: 'git@example.com:me/repo.git',
      dshHome: home,
      profile: 'desktop',
      branch: 'feature/sync',
    })
    const ctx = await resolveContext(config)
    assert.equal(ctx.profile, 'desktop')
    assert.equal(ctx.config.branch, 'feature/sync')
    assert.equal(ctx.profileDir, join(home, 'profiles', 'desktop'))
  })

  test('detects a profile that lists this package as a bundle', async () => {
    const home = await makeHome()
    const profileDir = join(home, 'profiles', 'work')
    await mkdir(profileDir, { recursive: true })
    await writeFile(
      join(profileDir, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: [PACKAGE_NAME] } } }),
    )
    const ctx = await resolveContext(
      normalizeConfig({ remote: 'git@example.com:me/repo.git', dshHome: home }),
    )
    assert.equal(ctx.profile, 'work')
  })

  test('rejects an unsafe branch name before touching Git', async () => {
    await assert.rejects(
      resolveContext(
        normalizeConfig({
          remote: 'git@example.com:me/repo.git',
          dshHome: await makeHome(),
          profile: 'desktop',
          branch: 'bad branch',
        }),
      ),
      { code: 'E_CONFIG' },
    )
  })
})
