import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { requireBranch, resolveDshHome } from './config.js'
import { SyncError } from './errors.js'
import { ensureDir, pathExists } from './paths.js'
import { sanitizeText } from './text.js'

const MAX_BUFFER = 32 * 1024 * 1024
const GIT_ENV = {
  // Never let a desktop app hang on an interactive credential prompt.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
  GIT_ASKPASS: 'echo',
  GIT_EDITOR: ':',
  GIT_PAGER: 'cat',
  ...(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH
    ? {}
    : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }),
}

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi
const QUERY_SECRET = /([?&](?:access[_-]?token|token|auth|key|password|secret)=)[^&#\s]*/gi

function maskRemoteText(text) {
  return String(text ?? '')
    .replace(URL_USERINFO, '$1<credentials>@')
    .replace(QUERY_SECRET, '$1<redacted>')
}

export function redactRemote(text, remote) {
  let out = String(text ?? '')
  if (remote) out = out.split(remote).join('<remote>')
  return sanitizeText(maskRemoteText(out), 800)
}

/** Remote URL safe to print in command output, logs and session transcripts. */
export function displayRemote(remote) {
  return maskRemoteText(String(remote ?? ''))
}

/** Decide which user-facing failure a rejected push represents. */
export function classifyPushFailure(text) {
  const detail = String(text ?? '')
  if (/non-fast-forward|\[rejected\]|fetch first|stale info|failed to push some refs/i.test(detail)) {
    return 'E_PUSH_REJECTED'
  }
  if (
    /authentication failed|could not read (?:username|password)|permission denied|access denied|repository not found|does not appear to be a git repository|terminal prompts disabled/i.test(
      detail,
    )
  ) {
    return 'E_AUTH'
  }
  return 'E_GIT'
}

function gitError(config, args, result) {
  if (result.spawnCode === 'ENOENT') {
    return new SyncError('E_GIT', `git executable not found: ${config.gitBin}`)
  }
  if (result.timedOut) {
    return new SyncError('E_GIT', `git ${args[0]} timed out after ${Math.round(result.timeoutMs / 1000)}s`)
  }
  const detail = redactRemote(result.stderr || result.stdout || 'unknown git failure', config.remote)
  return new SyncError('E_GIT', `git ${args[0]} failed: ${detail}`)
}

/**
 * Run one Git command. Text output is trimmed by default; binary callers pass
 * `encoding: null` and receive Buffers. `allowFail` resolves with the exit code
 * instead of throwing, which callers use for optional probes.
 */
function run(config, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.gitBin,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 120_000,
        maxBuffer: options.maxBuffer ?? MAX_BUFFER,
        windowsHide: true,
        encoding: options.encoding === undefined ? 'utf8' : options.encoding,
        env: { ...process.env, ...GIT_ENV },
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = Buffer.isBuffer(stdout)
          ? stdout
          : Buffer.from(typeof stdout === 'string' ? stdout : String(stdout ?? ''), 'utf8')
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
        const result = {
          code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          spawnCode: typeof error?.code === 'string' ? error.code : null,
          timedOut: Boolean(error?.killed || (error?.signal === 'SIGTERM')),
          timeoutMs: options.timeout ?? 120_000,
          stdout:
            options.encoding === null
              ? stdoutBuffer
              : options.trim === false
                ? stdoutBuffer.toString('utf8')
                : stdoutBuffer.toString('utf8').trim(),
          stderr: stderrText.trim(),
        }
        if (options.signal?.aborted || error?.name === 'AbortError') {
          reject(new SyncError('E_CANCELLED', `${args[0]} was cancelled`))
          return
        }
        if (error && !options.allowFail) {
          reject(gitError(config, args, result))
          return
        }
        resolve(result)
      },
    )
    // EPIPE can fire when git exits before reading all stdin (e.g. an error path);
    // ignore it — the exit callback still reports the real failure.
    if (child.stdin) child.stdin.on('error', () => {})
    if (options.input !== undefined && child.stdin) child.stdin.end(options.input)
  })
}

/** One cache repository per remote+branch, so profiles cannot clobber each other. */
export function workDir(config) {
  const branch = String(config.branch ?? '').trim() || 'main'
  const key = createHash('sha256')
    .update(`${config.remote}\0${branch}`)
    .digest('hex')
    .slice(0, 16)
  return join(resolveDshHome(config), 'config-sync', 'work', key)
}

async function headBranch(config, cwd, signal) {
  const result = await run(config, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    allowFail: true,
    signal,
  })
  return result.code === 0 && result.stdout ? result.stdout : null
}

/**
 * Create or refresh the plugin-owned cache repository. The cache mirrors the
 * configured branch; a missing branch becomes a fresh root branch so a new
 * sync branch never drags unrelated history (or a deleted branch's old tip)
 * from another branch.
 */
export async function ensureWorkTree(config, options = {}) {
  const branch = requireBranch(config)
  const dir = workDir(config)
  await ensureDir(dir)
  const hasGit = await pathExists(join(dir, '.git'))
  if (!hasGit) {
    await run(config, ['init', '-b', branch, '.'], { cwd: dir, signal: options.signal })
  }

  // The cache mirrors exact bytes: line-ending conversion would change hashes
  // between machines that share a manifest.
  await run(config, ['config', 'core.autocrlf', 'false'], { cwd: dir, signal: options.signal })
  await run(config, ['config', 'core.eol', 'lf'], { cwd: dir, signal: options.signal })
  await run(config, ['config', 'core.quotePath', 'false'], { cwd: dir, signal: options.signal })

  const current = await run(config, ['remote', 'get-url', 'origin'], {
    cwd: dir,
    allowFail: true,
    signal: options.signal,
  })
  if (current.code !== 0 || !current.stdout) {
    await run(config, ['remote', 'add', 'origin', config.remote], { cwd: dir, signal: options.signal })
  } else if (current.stdout !== config.remote) {
    await run(config, ['remote', 'set-url', 'origin', config.remote], { cwd: dir, signal: options.signal })
  }

  if (options.fetch === false) return dir

  // ls-remote separates "repository is empty" from "cannot reach/authorize".
  const ls = await run(config, ['ls-remote', '--heads', 'origin', branch], {
    cwd: dir,
    allowFail: true,
    timeout: 60_000,
    signal: options.signal,
  })
  if (ls.code !== 0) throw gitError(config, ['ls-remote'], ls)

  if (ls.stdout) {
    await run(config, ['fetch', '--prune', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      cwd: dir,
      timeout: 180_000,
      signal: options.signal,
    })
    const rev = await run(config, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: dir,
      allowFail: true,
      signal: options.signal,
    })
    if (rev.code !== 0 || !rev.stdout) {
      throw new SyncError('E_GIT', `cannot resolve fetched branch ${branch}`)
    }
    await run(config, ['clean', '-fdx'], { cwd: dir, allowFail: true, signal: options.signal })
    await run(config, ['reset', '--hard', rev.stdout], { cwd: dir, signal: options.signal })
    await run(config, ['checkout', '-B', branch, rev.stdout], { cwd: dir, signal: options.signal })
  } else {
    // The remote branch is gone. Detach before deleting any stale local ref,
    // otherwise `checkout --orphan` fails and HEAD silently re-attaches to the
    // old tip, which would later push stale content back to the remote.
    const head = await run(config, ['rev-parse', '--verify', 'HEAD'], {
      cwd: dir,
      allowFail: true,
      signal: options.signal,
    })
    if (head.code === 0) {
      await run(config, ['checkout', '--detach', '-f'], { cwd: dir, allowFail: true, signal: options.signal })
    }
    await run(config, ['update-ref', '-d', `refs/heads/${branch}`], {
      cwd: dir,
      allowFail: true,
      signal: options.signal,
    })
    await run(config, ['update-ref', '-d', `refs/remotes/origin/${branch}`], {
      cwd: dir,
      allowFail: true,
      signal: options.signal,
    })
    if (head.code === 0) {
      const orphan = await run(config, ['checkout', '--orphan', branch], {
        cwd: dir,
        allowFail: true,
        signal: options.signal,
      })
      if (orphan.code !== 0) {
        await run(config, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
          cwd: dir,
          allowFail: true,
          signal: options.signal,
        })
        await run(config, ['read-tree', '--empty'], { cwd: dir, allowFail: true, signal: options.signal })
      }
      await run(config, ['rm', '-rf', '--cached', '--quiet', '.'], {
        cwd: dir,
        allowFail: true,
        signal: options.signal,
      })
      await run(config, ['clean', '-fdx'], { cwd: dir, allowFail: true, signal: options.signal })
    } else {
      await run(config, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
        cwd: dir,
        allowFail: true,
        signal: options.signal,
      })
      await run(config, ['read-tree', '--empty'], { cwd: dir, allowFail: true, signal: options.signal })
    }
    const commit = await currentCommit(config, dir, options.signal)
    if (commit) {
      throw new SyncError(
        'E_GIT',
        `cache still points at ${commit.slice(0, 12)} after preparing new branch ${branch}; delete ${dir} and retry`,
      )
    }
  }

  const actual = await headBranch(config, dir, options.signal)
  if (actual !== branch) {
    throw new SyncError('E_GIT', `cache HEAD is ${actual ?? 'detached'}, expected branch ${branch}`)
  }
  return dir
}

export async function currentCommit(config, cwd, signal) {
  const result = await run(config, ['rev-parse', '--verify', 'HEAD'], { cwd, allowFail: true, signal })
  return result.code === 0 && result.stdout ? result.stdout : null
}

export async function headCommit(config, cwd, signal) {
  const commit = await currentCommit(config, cwd, signal)
  return commit ? commit.slice(0, 12) : null
}

/**
 * List committed tree entries below a prefix with their modes. Symlinks and
 * submodules are visible here, so callers can reject them before reading.
 */
export async function treeEntries(config, cwd, rev, prefix, signal) {
  const args = ['ls-tree', '-r', '-z', '--full-tree', rev]
  if (prefix) args.push('--', prefix)
  const result = await run(config, args, { cwd, trim: false, signal })
  const entries = []
  for (const chunk of result.stdout.split('\0')) {
    if (!chunk) continue
    const tab = chunk.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, sha] = chunk.slice(0, tab).split(' ')
    entries.push({ mode, type, sha, path: chunk.slice(tab + 1) })
  }
  return entries
}

/** Read a committed blob as a Buffer; null when the path does not exist. */
export async function readBlob(config, cwd, rev, path, signal) {
  const result = await run(config, ['cat-file', 'blob', `${rev}:${path}`], {
    cwd,
    encoding: null,
    allowFail: true,
    signal,
  })
  return result.code === 0 ? result.stdout : null
}

async function stageFile(config, cwd, path, data, signal) {
  const hash = await run(config, ['hash-object', '-w', '--no-filters', '--stdin'], {
    cwd,
    input: data,
    signal,
  })
  await run(config, ['update-index', '--add', '--cacheinfo', `100644,${hash.stdout},${path}`], {
    cwd,
    signal,
  })
  return hash.stdout
}

export async function indexEntries(config, cwd, prefix, signal) {
  const result = await run(config, ['ls-files', '-s', '-z', '--', prefix], {
    cwd,
    trim: false,
    signal,
  })
  const entries = new Map()
  for (const chunk of result.stdout.split('\0')) {
    if (!chunk) continue
    const tab = chunk.indexOf('\t')
    if (tab < 0) continue
    const [mode, sha] = chunk.slice(0, tab).split(' ')
    entries.set(chunk.slice(tab + 1), { mode, sha })
  }
  return entries
}

function verifyEntrySet(actual, expected, prefix) {
  for (const path of actual.keys()) {
    if (!path.startsWith(prefix)) {
      throw new SyncError('E_GIT', `staged a path outside the managed profile directory: ${sanitizeText(path, 160)}`)
    }
  }
  if (actual.size !== expected.size) {
    const missing = [...expected.keys()].filter((path) => !actual.has(path))
    const extra = [...actual.keys()].filter((path) => !expected.has(path))
    throw new SyncError(
      'E_GIT',
      `staged file set mismatch${missing.length ? `; missing: ${missing.map((p) => sanitizeText(p, 160)).join(', ')}` : ''}${
        extra.length ? `; unexpected: ${extra.map((p) => sanitizeText(p, 160)).join(', ')}` : ''
      }`,
    )
  }
  for (const [path, sha] of expected) {
    const entry = actual.get(path)
    if (!entry) throw new SyncError('E_GIT', `staged file is missing: ${sanitizeText(path, 160)}`)
    if (entry.mode !== '100644') {
      throw new SyncError('E_GIT', `staged file has an unexpected mode: ${sanitizeText(path, 160)}`)
    }
    if (entry.sha !== sha) {
      throw new SyncError('E_GIT', `staged content changed on disk: ${sanitizeText(path, 160)}`)
    }
  }
}

/**
 * Stage the exact bytes of every managed file, bypassing Git attributes and
 * .gitignore filters, then commit and verify the committed tree byte-for-byte.
 * Returns `changed: false` when the resulting tree equals the parent tree.
 */
export async function commitManagedFiles(config, cwd, { profile, files, message, signal }) {
  const prefix = `profiles/${profile}/`
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) {
      throw new SyncError('E_GIT', `refusing to commit a path outside ${prefix}: ${sanitizeText(path, 160)}`)
    }
  }
  await run(config, ['add', '-A', '-f', '--', prefix], { cwd, signal })
  const expected = new Map()
  for (const [path, data] of files) {
    expected.set(path, await stageFile(config, cwd, path, data, signal))
  }
  const index = await indexEntries(config, cwd, prefix, signal)
  verifyEntrySet(index, expected, prefix)

  const tree = (await run(config, ['write-tree'], { cwd, signal })).stdout
  const head = await currentCommit(config, cwd, signal)
  const parentTree = head
    ? (await run(config, ['rev-parse', '--verify', `${head}^{tree}`], { cwd, allowFail: true, signal })).stdout
    : null
  if (parentTree && parentTree === tree) return { changed: false, commit: head }

  await run(
    config,
    [
      '-c',
      `user.name=${config.authorName}`,
      '-c',
      `user.email=${config.authorEmail}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      message,
    ],
    { cwd, signal },
  )
  const commit = await currentCommit(config, cwd, signal)
  const committed = await treeEntries(config, cwd, 'HEAD', prefix, signal)
  const actual = new Map(committed.map((entry) => [entry.path, { mode: entry.mode, sha: entry.sha }]))
  verifyEntrySet(actual, expected, prefix)
  return { changed: true, commit }
}

/**
 * Remove one managed path from the index and commit the result, mirroring
 * how commitManagedFiles verifies the staged set. The work-tree copy is not
 * touched; callers decide whether a file should exist on disk. Used by the
 * connection probe to restore the branch after a write test.
 */
export async function removeManagedFile(config, cwd, { profile, path, message, signal }) {
  const prefix = `profiles/${profile}/`
  if (!path.startsWith(prefix)) {
    throw new SyncError('E_GIT', `refusing to remove a path outside ${prefix}: ${sanitizeText(path, 160)}`)
  }
  await run(config, ['rm', '--cached', '--', path], { cwd, signal })
  await run(
    config,
    [
      '-c',
      `user.name=${config.authorName}`,
      '-c',
      `user.email=${config.authorEmail}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      message,
    ],
    { cwd, signal },
  )
  const committed = await treeEntries(config, cwd, 'HEAD', prefix, signal)
  if (committed.some((entry) => entry.path === path)) {
    throw new SyncError('E_GIT', `the removed path is still committed: ${sanitizeText(path, 160)}`)
  }
  return currentCommit(config, cwd, signal)
}

export async function pushBranch(config, cwd, options = {}) {  const branch = requireBranch(config)
  const result = await run(config, ['push', 'origin', `HEAD:refs/heads/${branch}`], {
    cwd,
    allowFail: true,
    timeout: 180_000,
    signal: options.signal,
  })
  if (result.code !== 0) {
    const detail = redactRemote(result.stderr || result.stdout, config.remote)
    const code = classifyPushFailure(detail)
    if (code === 'E_PUSH_REJECTED') {
      throw new SyncError(
        'E_PUSH_REJECTED',
        `push rejected (${detail}). Another machine may have pushed; run pull first, then push again.`,
      )
    }
    if (code === 'E_AUTH') {
      throw new SyncError(
        'E_AUTH',
        `git push could not authenticate or find the remote (${detail}). Check the remote URL and credentials.`,
      )
    }
    throw new SyncError('E_GIT', `git push failed (${detail})`)
  }
  await run(config, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], {
    cwd,
    allowFail: true,
    signal: options.signal,
  })
}
