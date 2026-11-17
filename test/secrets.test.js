import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { scanForSecrets, summarizeSecrets } from '../src/secrets.js'

function scan(text, path = 'profiles/demo/cordis.patch.yml') {
  return scanForSecrets(new Map([[path, Buffer.from(text)]]))
}

describe('scanForSecrets', () => {
  test('ignores environment references and safe key names', () => {
    const text = [
      '- id: llm',
      '  config:',
      '    apiKeyEnv: BIFROST_API_KEY',
      '    apiKeyFile: /run/secrets/key',
      '    tokenUrl: https://example.com/token',
      '    password: ""',
      '    secret: ${MY_SECRET}',
      '    token: null',
      '',
    ].join('\n')
    assert.deepEqual(scan(text), [])
  })

  test('flags inline api keys without exposing the full value', () => {
    const findings = scan('- config:\n    apiKey: sk-abcdefghijklmnopqrstuvwxyz012345\n')
    assert.equal(findings.length >= 1, true)
    const summary = summarizeSecrets(findings)
    assert.match(summary, /apiKey has an inline value/)
    assert.ok(!summary.includes('abcdefghijklmnopqrstuvwxyz012345'))
  })

  test('handles quoted YAML and JSON keys', () => {
    assert.equal(scan('"apiKey": "sk-abcdefghijklmnopqrstuvwxyz012345"\n').length >= 1, true)
    const findings = scan('{\n  "password": "hunter2hunter2"\n}\n', 'profiles/demo/package.json')
    assert.equal(findings.length, 1)
    assert.equal(findings[0].line, 2)
  })

  test('flags common token prefixes and private key blocks', () => {
    assert.equal(scan('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n').length >= 1, true)
    assert.equal(scan('value: github_pat_abcdefghijklmnopqrstuvwxyz0123456789\n').length >= 1, true)
    assert.equal(scan('aws: AKIA1234567890ABCDEF\n').length >= 1, true)
    assert.equal(
      scan('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n').length,
      1,
    )
  })

  test('ignores comments and unrelated keys', () => {
    assert.deepEqual(scan('# apiKey: sk-abcdefghijklmnopqrstuvwxyz012345\n'), [])
    assert.deepEqual(scan('name: my-token-helper\n'), [])
    assert.deepEqual(scan('maxTokens: 4096\n'), [])
  })

  test('reports line numbers for YAML findings', () => {
    const findings = scan('- id: llm\n  config:\n    password: hunter2hunter2\n')
    assert.equal(findings.length, 1)
    assert.equal(findings[0].line, 3)
    assert.equal(findings[0].path, 'profiles/demo/cordis.patch.yml')
  })

  test('summarizes many findings without dumping them all', () => {
    const lines = []
    for (let index = 0; index < 12; index += 1) lines.push(`  password: value-${index}-xxxxxxxx`)
    const summary = summarizeSecrets(scan(lines.join('\n')))
    assert.match(summary, /and 4 more/)
  })
})
