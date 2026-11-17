import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

async function exists(path) {
  try {
    await stat(join(root, path))
    return true
  } catch {
    return false
  }
}

async function locale(name) {
  return JSON.parse(await readFile(join(root, 'locale', name), 'utf8'))
}

describe('package manifest', () => {
  test('declares the published identity and DSH compatibility where DSH reads it', () => {
    assert.equal(pkg.name, 'dsh-config-git-sync')
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(pkg.dsh.engines, undefined)
    assert.match(pkg.engines.dsh, /^>=0\.2\.2-rc\.3 <0\.3\.0$/)
    assert.match(pkg.engines.node, />=22\.19/)
    assert.equal(pkg.repository.url, 'git+https://github.com/FairmeHIT/dsh-sync.git')
    assert.equal(pkg.license, 'MIT')
  })

  test('packages every runtime and display resource', async () => {
    for (const path of [
      'index.js',
      'src',
      'cordis.patch.yml',
      'icon.svg',
      'locale/en.json',
      'locale/zh.json',
      'docs/DETAIL.md',
      'docs/DETAIL.zh.md',
      'docs/preview.svg',
      'README.md',
      'README.en.md',
      'CHANGELOG.md',
      'SECURITY.md',
      'LICENSE',
    ]) {
      assert.ok(await exists(path), `missing ${path}`)
    }
    for (const path of ['locale', 'docs', 'icon.svg', 'src', 'index.js']) {
      assert.ok(pkg.files.includes(path), `package.json files must include ${path}`)
    }
    assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
    assert.equal(pkg.exports['./icon'], './icon.svg')
  })

  test('the bundle patch names the package and its row id stays stable', async () => {
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, new RegExp(`name: ${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(patch, /id: config-sync/)
  })

  test('the lockfile mirrors the package identity', async () => {
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
    assert.equal(lock.name, pkg.name)
    assert.equal(lock.version, pkg.version)
    assert.equal(lock.packages[''].name, pkg.name)
  })
})

describe('Plugin Manager display metadata', () => {
  test('English and Chinese metadata point at existing detail documents', async () => {
    for (const name of ['en.json', 'zh.json']) {
      const meta = (await locale(name)).meta
      assert.equal(typeof meta.title, 'string')
      assert.ok(meta.title.length > 0)
      assert.equal(typeof meta.description, 'string')
      assert.ok(meta.description.length > 20)
      assert.ok(await exists(meta.detail), `missing detail document ${meta.detail}`)

      const document = await readFile(join(root, meta.detail), 'utf8')
      const lines = document.trim().split(/\r?\n/)
      assert.equal(lines.length, 1, `${meta.detail} must contain exactly one image line`)
      const image = /^!\[([^\]]+)\]\(([^)]+)\)$/.exec(lines[0])
      assert.ok(image, `${meta.detail} must be a Markdown image line`)
      assert.equal(image[1].trim().length > 0, true, `${meta.detail} needs alternative text`)
      assert.ok(await exists(join('docs', image[2])), `missing preview image ${image[2]}`)
    }
  })

  test('the icon and preview are self-contained SVGs of the expected size', async () => {
    const icon = await readFile(join(root, 'icon.svg'), 'utf8')
    assert.match(icon, /viewBox="0 0 36 36"/)
    assert.doesNotMatch(icon, /<text|<style|<script|<foreignObject|<image/)
    assert.doesNotMatch(icon, /<rect[^>]*width="36"/, 'the icon must not draw its own tile')

    const preview = await readFile(join(root, 'docs', 'preview.svg'), 'utf8')
    assert.match(preview, /width="640" height="300" viewBox="0 0 640 300"/)
    assert.doesNotMatch(preview, /<text|<style|<script|<foreignObject/)
  })
})
