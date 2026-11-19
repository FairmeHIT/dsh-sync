import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { after, test } from 'node:test'
import { normalizeConfig } from '../src/config.js'
import { commitManagedFiles, ensureWorkTree, pushBranch } from '../src/git.js'
import { testConnection } from '../src/sync.js'

const execFileAsync = promisify(execFile)
const tempDirs = []

async function makeTemp() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-connection-'))
  tempDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Run one git command; resolves { code, stdout, stderr } without throwing. */
async function gitRun(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
    return { code: 0, stdout: String(stdout ?? ''), stderr: '' }
  } catch (error) {
    return { code: 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) }
  }
}

/**
 * The card's Test connection button goes through testConnection(), which hands
 * probeRemote a hand-built adapter instead of the whole git module. 0.7.1
 * shipped an adapter missing indexEntries, so every connection test died with
 * "git.indexEntries is not a function" even though probeRemote's own e2e tests
 * (which pass the full module) were green. This test drives the real entry
 * point against a remote that already holds synced files, which is the state a
 * second machine sees.
 */
test('testConnection works on a remote that already holds synced files', async () => {
  const base = await makeTemp()
  const remoteDir = join(base, 'remote.git')
  await mkdir(remoteDir)
  await gitRun(remoteDir, ['init', '--bare', '-b', 'main', '.'])

  const seed = join(base, 'seed')
  await mkdir(join(seed, 'profiles', 'demo'), { recursive: true })
  await gitRun(seed, ['init', '-b', 'main', '.'])
  const seedConfig = normalizeConfig({
    remote: remoteDir,
    branch: 'main',
    profile: 'demo',
    dshHome: join(base, 'seedhome'),
  })
  const seeded = new Map([
    ['profiles/demo/package.json', Buffer.from('{"name":"seed"}\n', 'utf8')],
    ['profiles/demo/cordis.patch.yml', Buffer.from('- insert:\n    - id: seed\n', 'utf8')],
  ])
  await gitRun(seed, ['remote', 'add', 'origin', remoteDir])
  const seededWork = await ensureWorkTree(seedConfig, { fetch: false })
  for (const [path, data] of seeded) {
    await mkdir(join(seededWork, dirname(path)), { recursive: true })
    await writeFile(join(seededWork, path), data)
  }
  await commitManagedFiles(seedConfig, seededWork, { profile: 'demo', files: seeded, message: 'seed' })
  await pushBranch(seedConfig, seededWork, {})

  const home = join(base, 'home')
  await mkdir(join(home, 'profiles', 'demo'), { recursive: true })
  const config = normalizeConfig({
    remote: remoteDir,
    branch: 'main',
    profile: 'demo',
    dshHome: home,
  })

  const text = await testConnection(config)
  assert.match(text, /read: ok/)
  assert.match(text, /write: ok/)
  assert.match(text, /round-trip: ok/)
  assert.match(text, /cleanup: ok/)

  const tree = await gitRun(remoteDir, ['ls-tree', '-r', 'HEAD'])
  assert.ok(!tree.stdout.includes('.config-sync-probe'), `marker leaked: ${tree.stdout}`)
  for (const [path, data] of seeded) {
    const blob = await gitRun(remoteDir, ['cat-file', 'blob', `HEAD:${path}`])
    assert.equal(blob.stdout, data.toString('utf8'), `${path} changed by the connection test`)
  }
})
