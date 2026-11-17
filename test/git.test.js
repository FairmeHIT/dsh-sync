import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { classifyPushFailure, displayRemote, redactRemote, workDir } from '../src/git.js'

describe('workDir', () => {
  test('keys the cache by remote and branch under the harness home', () => {
    const base = 'C:\\dsh-home'
    const first = workDir({ dshHome: base, remote: 'git@example.com:me/repo.git', branch: 'main' })
    assert.equal(dirname(first), join(base, 'config-sync', 'work'))
    assert.equal(workDir({ dshHome: base, remote: 'git@example.com:me/repo.git', branch: 'main' }), first)
    assert.notEqual(workDir({ dshHome: base, remote: 'git@example.com:me/other.git', branch: 'main' }), first)
    assert.notEqual(workDir({ dshHome: base, remote: 'git@example.com:me/repo.git', branch: 'config' }), first)
  })

  test('resolves the default harness home instead of the process cwd', () => {
    const previous = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      assert.equal(
        dirname(workDir({ dshHome: '', remote: 'r', branch: 'main' })),
        join(homedir(), '.dsh', 'config-sync', 'work'),
      )
    } finally {
      if (previous !== undefined) process.env.DSH_HOME = previous
    }
  })

  test('honors DSH_HOME', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = 'C:\\from-env'
    try {
      assert.equal(
        dirname(workDir({ dshHome: '', remote: 'r', branch: 'main' })),
        join('C:\\from-env', 'config-sync', 'work'),
      )
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('displayRemote', () => {
  test('masks userinfo for every scheme but keeps ordinary URLs readable', () => {
    assert.equal(
      displayRemote('https://user:token@example.com/me/repo.git'),
      'https://<credentials>@example.com/me/repo.git',
    )
    assert.equal(displayRemote('ssh://user:pass@example.com/repo.git'), 'ssh://<credentials>@example.com/repo.git')
    assert.equal(displayRemote('git@github.com:me/repo.git'), 'git@github.com:me/repo.git')
    assert.equal(displayRemote('C:\\repos\\remote.git'), 'C:\\repos\\remote.git')
  })

  test('masks credential-like query parameters', () => {
    assert.equal(
      displayRemote('https://example.com/repo.git?access_token=secret&x=1'),
      'https://example.com/repo.git?access_token=<redacted>&x=1',
    )
    assert.equal(
      displayRemote('https://example.com/repo.git?token=a&password=b'),
      'https://example.com/repo.git?token=<redacted>&password=<redacted>',
    )
  })
})

describe('redactRemote', () => {
  test('removes the configured remote and embedded credentials from Git output', () => {
    const remote = 'https://user:token@example.com/me/repo.git'
    const text = `fatal: unable to access '${remote}': 403`
    const redacted = redactRemote(text, remote)
    assert.ok(!redacted.includes('token'))
    assert.ok(redacted.includes('<remote>'))
    assert.equal(
      redactRemote('error at https://other:secret@example.com/x', remote),
      'error at https://<credentials>@example.com/x',
    )
    assert.equal(
      redactRemote('error at https://example.com/x?access_token=secret', remote),
      'error at https://example.com/x?access_token=<redacted>',
    )
  })
})

describe('classifyPushFailure', () => {
  test('separates non-fast-forward rejection from authentication failures', () => {
    assert.equal(
      classifyPushFailure('! [rejected] main -> main (non-fast-forward)'),
      'E_PUSH_REJECTED',
    )
    assert.equal(
      classifyPushFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
      'E_AUTH',
    )
    assert.equal(classifyPushFailure('remote: Repository not found.'), 'E_AUTH')
    assert.equal(classifyPushFailure('fatal: unable to access: Could not resolve host'), 'E_GIT')
  })
})
