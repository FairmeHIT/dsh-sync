import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBundledRuntime, bundledPnpmInvocation } from '../src/runtime.js'

function makeFakeRuntime(root) {
  const dir = join(root, 'dependencies', 'pnpm', 'bin')
  const nodeDir = join(root, 'dependencies', 'node', 'bin')
  const nodeExe = process.platform === 'win32' ? 'node.exe' : 'node'
  return Promise.all([
    mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, 'pnpm.cjs'), '')),
    mkdir(nodeDir, { recursive: true }).then(() => writeFile(join(nodeDir, nodeExe), '')),
  ])
}

test('findBundledRuntime returns null when no runtime exists', () => {
  assert.equal(findBundledRuntime('C:/definitely-not-a-real-home'), null)
})

test('findBundledRuntime locates the dshHome primary runtime', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-runtime-test-'))
  try {
    const home = join(base, 'home')
    await mkdir(home, { recursive: true })
    await makeFakeRuntime(join(home, 'dsh-runtimes', 'dsh-primary-runtime'))
    const found = findBundledRuntime(home)
    assert.ok(found)
    assert.match(found.pnpm, /dependencies[\\/]pnpm[\\/]bin[\\/]pnpm\.cjs$/)
    assert.ok(found.node)
    const invocation = bundledPnpmInvocation(found)
    assert.equal(invocation.tool, 'pnpm (bundled)')
    assert.equal(invocation.command, found.node)
    assert.deepEqual(invocation.args, [found.pnpm, 'install'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('findBundledRuntime prefers DSH_PACK_HOME over dshHome', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-runtime-test-'))
  const previous = process.env.DSH_PACK_HOME
  try {
    const packHome = join(base, 'pack-home')
    const home = join(base, 'home')
    await mkdir(home, { recursive: true })
    await makeFakeRuntime(packHome)
    process.env.DSH_PACK_HOME = packHome
    const found = findBundledRuntime(home)
    assert.ok(found)
    assert.equal(found.root, packHome)
  } finally {
    if (previous === undefined) delete process.env.DSH_PACK_HOME
    else process.env.DSH_PACK_HOME = previous
    await rm(base, { recursive: true, force: true })
  }
})

test('bundledPnpmInvocation still names a command when node is missing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-runtime-test-'))
  try {
    const root = join(base, 'runtime')
    const dir = join(root, 'dependencies', 'pnpm', 'bin')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'pnpm.cjs'), '')
    const invocation = bundledPnpmInvocation({ root, pnpm: join(dir, 'pnpm.cjs'), node: null })
    assert.equal(invocation.command, 'node')
    assert.deepEqual(invocation.args, [join(dir, 'pnpm.cjs'), 'install'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('bundledPnpmInvocation returns null for a missing runtime', () => {
  assert.equal(bundledPnpmInvocation(null), null)
})
