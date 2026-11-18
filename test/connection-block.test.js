import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CONNECTION_FILE,
  findRowSpan,
  mergeConnectionRow,
  rowText,
  stripConnectionRow,
} from '../src/connection-block.js'

const LOCAL = [
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-08-13.1',
  '- id: config-sync',
  '  name: dsh-config-git-sync',
  '  config:',
  '    remote: https://github.com/me/dsh-plugins.git',
  '    branch: main',
  '    profile: desktop',
  '- id: other',
  '  name: dsh-other',
  '',
].join('\n')

describe('findRowSpan', () => {
  test('finds the row that owns a top-level list item', () => {
    const span = findRowSpan(LOCAL, 'config-sync')
    assert.ok(span)
    assert.match(LOCAL.slice(span.start, span.end), /^ {4}remote: https:\/\/github\.com\/me\/dsh-plugins\.git/m)
    assert.doesNotMatch(LOCAL.slice(span.start, span.end), /dsh-other/)
  })

  test('matches quoted row ids and inline id values', () => {
    const text = "- insert: []\n- id: 'config-sync'\n  name: x\n"
    assert.ok(findRowSpan(text, 'config-sync'))
    const inline = '- id: config-sync\n  name: x\n'
    assert.ok(findRowSpan(inline, 'config-sync'))
  })

  test('does not mistake a nested id key for the row id', () => {
    const text = '- id: llm\n  config:\n    models:\n      - id: config-sync\n'
    assert.equal(findRowSpan(text, 'config-sync'), null)
  })

  test('returns null when the row is absent or the text is not a patch list', () => {
    assert.equal(findRowSpan(LOCAL, 'missing'), null)
    assert.equal(findRowSpan('', 'config-sync'), null)
    assert.equal(findRowSpan('config: {}\n', 'config-sync'), null)
  })
})

describe('stripConnectionRow', () => {
  test('removes only the connection row and keeps every other byte', () => {
    const stripped = stripConnectionRow(LOCAL, 'config-sync')
    assert.doesNotMatch(stripped, /config-sync/)
    assert.match(stripped, /welcomeNoticeVersion: 2026-08-13\.1/)
    assert.match(stripped, /- id: other/)
    assert.ok(stripped.endsWith('\n'))
    assert.equal(stripped, stripConnectionRow(stripped, 'config-sync'))
  })

  test('leaves a patch without the row untouched', () => {
    const text = '- id: other\n  name: dsh-other\n'
    assert.equal(stripConnectionRow(text, 'config-sync'), text)
    assert.equal(stripConnectionRow('', 'config-sync'), '')
  })

  test('rowText returns the exact block that strip removed', () => {
    const block = rowText(LOCAL, 'config-sync')
    assert.match(block, /^- id: config-sync$/m)
    assert.match(block, /remote: https:\/\/github\.com\/me\/dsh-plugins\.git/)
    assert.equal(rowText(LOCAL, 'missing'), null)
  })
})

describe('mergeConnectionRow', () => {
  test('keeps this machine row and drops the remote copy', () => {
    const remote = [
      '- id: config-sync',
      '  name: dsh-config-git-sync',
      '  config:',
      '    remote: https://github.com/other/machine.git',
      '- id: other',
      '  name: dsh-other-from-remote',
      '',
    ].join('\n')
    const merged = mergeConnectionRow(remote, LOCAL, 'config-sync')
    assert.doesNotMatch(merged, /other\/machine\.git/)
    assert.match(merged, /remote: https:\/\/github\.com\/me\/dsh-plugins\.git/)
    assert.match(merged, /name: dsh-other-from-remote/)
    assert.equal(merged.match(/- id: config-sync/g).length, 1)
    assert.ok(merged.endsWith('\n'))
  })

  test('adopts a remote row when this machine has none', () => {
    const remote = '- id: config-sync\n  name: dsh-config-git-sync\n'
    assert.equal(mergeConnectionRow(remote, '- id: other\n', 'config-sync'), remote)
  })

  test('appends the local row to a remote patch that lacks it', () => {
    const merged = mergeConnectionRow('- id: other\n', LOCAL, 'config-sync')
    assert.match(merged, /^- id: other$/m)
    assert.match(merged, /- id: config-sync\n {2}name: dsh-config-git-sync/)
    assert.ok(merged.endsWith('\n'))
  })

  test('is a no-op when neither side has a row', () => {
    assert.equal(mergeConnectionRow('- id: other\n', '', 'config-sync'), '- id: other\n')
    assert.equal(mergeConnectionRow('', '', 'config-sync'), '')
  })

  test('keeps CRLF line endings when merging the row back', () => {
    const crlf = (text) => text.replaceAll('\n', '\r\n')
    const remote = '- insert:\r\n    - id: theme\r\n      name: dsh-theme\r\n'
    const local = `${remote}${crlf('- id: config-sync\n  config:\n    remote: https://example.com/a.git\n')}`
    assert.equal(stripConnectionRow(local, 'config-sync'), remote)
    assert.equal(mergeConnectionRow(remote, local, 'config-sync'), local)
    // CRLF content that also had an appended row must not mix line endings.
    const merged = mergeConnectionRow(remote, local, 'config-sync')
    assert.equal(merged.match(/\r\n/g).length, merged.match(/\n/g).length)
  })

  test('names the synced file and row id it manages', () => {
    assert.equal(CONNECTION_FILE, 'cordis.patch.yml')
    assert.equal(rowText(LOCAL, 'config-sync').includes('config-sync'), true)
  })
})
