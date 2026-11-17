import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { sanitizeText, summarizeList } from '../src/text.js'

describe('sanitizeText', () => {
  test('collapses newlines and strips control/ANSI introducers', () => {
    assert.equal(sanitizeText('a\nb\tc'), 'a b c')
    assert.equal(sanitizeText('x\u001b]0;title\u0007y'), 'x ]0;title y')
    assert.equal(sanitizeText('a\u001b[31mred'), 'a [31mred')
    assert.equal(sanitizeText('\u0000\u0001\u007f'), '')
  })

  test('bounds length for remote-controlled fields', () => {
    const text = sanitizeText('x'.repeat(300), 20)
    assert.equal(text.length, 20)
    assert.ok(text.endsWith('\u2026'))
  })
})

describe('summarizeList', () => {
  test('sanitizes entries and clips long lists', () => {
    assert.equal(summarizeList(['a', 'b']), 'a, b')
    const text = summarizeList(['a\nb', 'c\td', 'e', 'f'], 2)
    assert.equal(text, 'a b, c d and 2 more')
  })
})
