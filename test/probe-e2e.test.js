import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { after, test } from 'node:test'
import { normalizeConfig } from '../src/config.js'
import { probeRemote } from '../src/probe.js'
import {
  commitManagedFiles,
  currentCommit,
  ensureWorkTree,
  pushBranch,
  readBlob,
  removeManagedFile,
} from '../src/git.js'

const execFileAsync = promisify(execFile)
const tempDirs = []

async function makeTemp() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-probe-'))
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

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const git = {
  ensureWorkTree,
  commitManagedFiles,
  pushBranch,
  currentCommit,
  readBlob,
  removeManagedFile,
}

test('probeRemote writes, verifies and cleans a marker on a live bare remote', async () => {
  const base = await makeTemp()
  const remoteDir = join(base, 'remote.git')
  await mkdir(remoteDir)
  // A bare remote with an initial empty commit on main, exactly how real
  // config-sync remotes start.
  const init = await gitRun(remoteDir, ['init', '--bare', '-b', 'main', '.'])
  assert.equal(init.code, 0, init.stderr)
  const seed = join(base, 'seed')
  await mkdir(seed)
  const s1 = await gitRun(seed, ['init', '-b', 'main', '.'])
  const s2 = await gitRun(
    seed,
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init'],
  )
  const s3 = await gitRun(seed, ['push', remoteDir, 'main'])
  assert.equal(s3.code, 0, s3.stderr)

  const home = join(base, 'home')
  await mkdir(join(home, 'profiles', 'demo'), { recursive: true })
  const config = normalizeConfig({
    remote: remoteDir,
    branch: 'main',
    profile: 'demo',
    dshHome: home,
  })

  const text = await probeRemote(config, git)
  assert.match(text, /read: ok/)
  assert.match(text, /write: ok/)
  assert.match(text, /round-trip: ok/)
  assert.match(text, /cleanup: ok/)
  assert.match(text, /Connection test passed/)

  // The marker must not remain on the remote tip.
  const tree = await gitRun(remoteDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
  assert.equal(tree.code, 0)
  assert.ok(!tree.stdout.split('\n').some((line) => line.includes('.config-sync-probe')), `marker leaked: ${tree.stdout}`)
  // And not in the work tree either.
  const work = await ensureWorkTree(config, { fetch: false })
  const listing = await gitRun(work, ['ls-files'])
  assert.ok(!listing.stdout.includes('.config-sync-probe'))
})

test('probeRemote refuses to run without a remote', async () => {
  const base = await makeTemp()
  const home = join(base, 'home')
  await mkdir(join(home, 'profiles', 'demo'), { recursive: true })
  await assert.rejects(
    probeRemote(normalizeConfig({ remote: '', branch: 'main', profile: 'demo', dshHome: home }), git),
    /no git remote configured/,
  )
})
