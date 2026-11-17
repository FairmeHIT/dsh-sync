import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeConfig } from '../src/config.js'

export const hasGit = await new Promise((resolve) => {
  execFile('git', ['--version'], { windowsHide: true }, (error) => resolve(!error))
})

export const skip = hasGit ? false : 'git is not installed'

export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`))
        else resolve(String(stdout).trim())
      },
    )
  })
}

export function gitBuffer(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr)}`))
        else resolve(stdout)
      },
    )
  })
}

export function gitInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr || `exit ${code}`}`))
    })
    child.stdin.end(input)
  })
}

export async function makeRoot(prefix = 'dsh-sync-e2e-') {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function initRemote(root, name = 'remote.git') {
  await git(root, ['init', '--bare', '--initial-branch=main', name])
  return join(root, name)
}

export function pkg({ extra = null, context = '0.85.1' } = {}) {
  const dependencies = { 'dsh-context': context }
  if (extra) dependencies[extra] = '^1.0.0'
  return `${JSON.stringify(
    {
      name: 'dsh-profile-demo',
      private: true,
      dependencies,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context', ...(extra ? [extra] : [])] } },
    },
    null,
    2,
  )}\n`
}

export async function makeMachine(root, name, files) {
  const home = join(root, name)
  const profileDir = join(home, 'profiles', 'demo')
  await mkdir(profileDir, { recursive: true })
  for (const [file, content] of Object.entries(files)) await writeFile(join(profileDir, file), content)
  // A credentials file that must never be read or copied.
  await writeFile(join(home, '.credentials.yaml'), 'secret: do-not-sync\n')
  return home
}

export function config(root, home, extra = {}) {
  return normalizeConfig({
    remote: join(root, 'remote.git'),
    dshHome: home,
    profile: 'demo',
    reconcile: 'none',
    ...extra,
  })
}

export async function cloneRemote(root) {
  const dir = await mkdtemp(join(root, 'clone-'))
  await git(root, ['clone', '--quiet', join(root, 'remote.git'), dir])
  await git(dir, ['config', 'user.name', 'foreign'])
  await git(dir, ['config', 'user.email', 'foreign@example.com'])
  // Keep foreign commits byte-faithful; a helper that silently rewrites line
  // endings would corrupt the manifest it is meant to leave alone.
  await git(dir, ['config', 'core.autocrlf', 'false'])
  await git(dir, ['config', 'core.eol', 'lf'])
  return dir
}

/** Add one commit to the bare remote from a throwaway clone. */
export async function commitToRemote(root, files, { message = 'foreign commit', branch = 'main' } = {}) {
  const dir = await cloneRemote(root)
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(dir, ...path.split('/'))
      if (content === null) {
        await rm(target, { force: true })
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    // Stage only the paths this commit owns. `git add -A` without a pathspec can
    // renormalize unrelated files when a .gitattributes file is introduced.
    const paths = Object.keys(files)
    if (paths.length > 0) await git(dir, ['add', '-A', '--', ...paths])
    await git(dir, ['commit', '--no-verify', '-m', message])
    await git(dir, ['push', 'origin', `HEAD:refs/heads/${branch}`])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Replace a committed path with a symlink object, without touching the host filesystem. */
export async function commitSymlink(root, path, target, { message = 'symlink commit' } = {}) {
  const dir = await cloneRemote(root)
  try {
    const sha = await gitInput(dir, ['hash-object', '-w', '--no-filters', '--stdin'], target)
    await git(dir, ['update-index', '--add', '--cacheinfo', `120000,${sha},${path}`])
    await git(dir, ['commit', '--no-verify', '-m', message])
    await git(dir, ['push', 'origin', 'HEAD:refs/heads/main'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function snapshotDirs(home) {
  try {
    const entries = await readdir(join(home, 'config-sync', 'snapshots', 'demo'), {
      withFileTypes: true,
    })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export async function readProfileFile(home, file) {
  return readFile(join(home, 'profiles', 'demo', file))
}

export async function remoteHead(root, branch = 'main') {
  return git(join(root, 'remote.git'), ['rev-parse', branch])
}
