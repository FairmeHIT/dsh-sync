import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateRemoteFields, createConfigEditor, publicConfig } from '../src/remote-config.js'

const fields = { remote: 'https://example.com/team/config.git', branch: 'main', profile: '' }

test('validates HTTPS, SSH, scp and trusted-server local paths', () => {
  for (const remote of [fields.remote, 'ssh://git@example.com/team/config.git', 'git@example.com:team/config.git', 'D:/repos/config.git', '/srv/config.git', '../config.git']) {
    assert.deepEqual(validateRemoteFields({ ...fields, remote }), { ...fields, remote })
  }
  assert.deepEqual(validateRemoteFields({ remote: '', branch: '', profile: '' }), { ...fields, remote: '' })
})

test('rejects credentials, protocols, options, controls and extra fields without echoing input', () => {
  for (const remote of ['https://user:secret@example.com/a', 'https://user@example.com/a', 'ssh://git:secret@example.com/a', 'https://example.com/a?secret=x', 'https://example.com/a#secret', 'https://example.com/a?other=secret', 'https://git:secret@example.com/a', 'https://example.com/a\\b', 'git://example.com/a', 'mailto:secret', 'ftp://example.com/a', 'file:///tmp/a', '-upload-pack=x', 'ext::secret', 'https://example.com/a\n', 'https://example.com/%0a', 'git@example.com:--option', 'x'.repeat(2049)]) {
    assert.throws(() => validateRemoteFields({ ...fields, remote }), (error) => error.code === 'E_CONFIG_INPUT' && !error.message.includes(remote))
  }
  for (const patch of [{ gitBin: 'secret' }, { branch: 'foo..bar' }, { branch: '-x' }, { branch: 'a b' }, { branch: 'foo.lock' }, { profile: '../secret' }, { profile: 'a/b' }, { remote: 3 }]) {
    assert.throws(() => validateRemoteFields({ ...fields, ...patch }), { code: 'E_CONFIG_INPUT' })
  }
})

test('public config does not expose masked credentials as editable values', () => {
  const result = publicConfig({ ...fields, remote: 'https://user:secret@example.com/a?token=secret', gitBin: 'private' })
  assert.equal(result.remote, '')
  assert.equal(result.remoteEditable, false)
  assert.equal(result.persistence, 'profile-patch')
  assert.doesNotMatch(JSON.stringify(result), /secret|private/)
  assert.equal(publicConfig(fields).remote, fields.remote)
  assert.doesNotMatch(JSON.stringify(publicConfig({ ...fields, remote: 'https://example.com/a?other=private-value' })), /private-value/)
  assert.doesNotMatch(JSON.stringify(publicConfig({ ...fields, remote: 'git:private-value@example.com:a' })), /private-value/)
})

test('editor uses entry and latest callback data, preserving unrelated fields', async () => {
  const entry = {}, current = { gitBin: 'custom', snapshot: false, remote: 'old', concurrent: 2 }
  const ctx = { fiber: { entry }, get: (name) => {
    assert.equal(name, 'configEditor')
    return { async edit(target, callback) { assert.equal(target, entry); Object.assign(current, callback(current)) } }
  } }
  await createConfigEditor(ctx).save(fields)
  assert.deepEqual(current, { ...current, ...fields, gitBin: 'custom', snapshot: false, concurrent: 2 })
})

test('editor unavailable and failures are explicit and sanitized', async () => {
  await assert.rejects(createConfigEditor({}).save(fields), { code: 'E_CONFIG_EDITOR' })
  const ctx = { fiber: { entry: {} }, get: () => ({ edit: async () => { throw new Error('secret credentials') } }) }
  await assert.rejects(createConfigEditor(ctx).save(fields), (error) => error.code === 'E_CONFIG_SAVE' && !error.message.includes('secret'))
})

test('concurrent saves for the same entry are rejected while storage is pending', async () => {
  let resolve
  const ctx = { fiber: { entry: {} }, get: () => ({ edit: () => new Promise((r) => { resolve = r }) }) }
  const first = createConfigEditor(ctx).save(fields)
  await assert.rejects(createConfigEditor(ctx).save(fields), { code: 'E_CONFIG_BUSY' })
  resolve(); await first
  await assert.rejects(createConfigEditor({}).save(fields), { code: 'E_CONFIG_EDITOR' })
})
