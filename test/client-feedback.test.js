import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const status = { ok: true, remote: 'repo', branch: 'main', profile: 'work', text: 'Status output' }
const response = (data, ok = true) => ({ ok, json: async () => data })
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function setup({ language = 'en', confirm = true, configFailure = false, config = { ...status, remoteEditable: true, persistence: 'profile-patch' } } = {}) {
  let current, initial = true, effect, Card, exported
  const calls = [], queue = [], configCalls = [], configQueue = []
  const timers = new Map(); let timerId = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(value) {
      if (initial) current = value
      return [current, (next) => { current = typeof next === 'function' ? next(current) : next }]
    },
    useCallback: (callback) => callback,
    useEffect(fn) { if (initial) effect = fn },
  }
  const window = { confirm: () => confirm, __ModuleLoader__: { load(def) { exported = def.factory(() => React) } } }
  const fetch = (path, options) => {
    if (path === '/api/config-sync/config') {
      configCalls.push({ path, options })
      if (configFailure === true && configCalls.length === 1) return Promise.reject(new Error('offline'))
      if (configFailure === 'hang' && configCalls.length === 1) return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      const next = configQueue.length ? configQueue.shift() : response(config)
      if (next === 'hang') return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      return Promise.resolve(next)
    }
    calls.push({ path, options })
    assert.ok(queue.length, `unexpected request: ${path}`)
    return Promise.resolve(queue.shift())
  }
  new Function('window', 'navigator', 'fetch', 'setTimeout', 'clearTimeout', source)(window, { language }, fetch, (resolve, ms) => {
    if (ms === 500) { resolve(); return 0 }
    timers.set(++timerId, resolve); return timerId
  }, (id) => timers.delete(id))
  exported.apply({ inject(_services, cb) { cb({ slots: {
    inject(_name, factory) { factory().next() },
    register(meta, component) { if (meta.name === 'plugins.bundle.config') Card = component },
  } }) } })
  const render = () => { const tree = Card(); initial = false; return tree }
  const nodes = (root) => [root, ...root.children.flatMap((child) => child && typeof child === 'object' ? nodes(child) : [])]
  const text = (node) => node.children.map((child) => child && typeof child === 'object' ? text(child) : child || '').join('')
  const find = (predicate) => nodes(render()).find(predicate)
  const button = (label) => { const node = find((n) => n.type === 'button' && text(n) === label); assert.ok(node, `button ${label}`); return node }
  const notice = () => { const node = find((n) => n.props.role === 'status'); return node && text(node) }
  const pre = () => text(find((n) => n.type === 'pre'))
  queue.push(response(status)); render(); effect()
  return { calls, queue, configCalls, configQueue, render, find, text, button, notice, pre, expire: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()) } }
}

test('failed initial config load cannot save unknown defaults and explicit retry restores form', async () => {
  const ui = setup({ configFailure: true }); await tick()
  assert.equal(ui.button('Save configuration').props.disabled, true)
  assert.equal(ui.find((n) => n.props['aria-label'] === 'Remote').props.disabled, true)
  ui.button('Save configuration').props.onClick(); await tick()
  assert.equal(ui.configCalls.length, 1)
  ui.button('Retry loading configuration').props.onClick(); await tick()
  assert.equal(ui.button('Save configuration').props.disabled, false)
  assert.equal(ui.find((n) => n.props['aria-label'] === 'Remote').props.value, 'repo')
})

test('hidden old remote requires explicit nonempty replacement, not branch-only save', async () => {
  const ui = setup({ config: { ok: true, remote: '', branch: 'main', profile: '', remoteEditable: false } }); await tick()
  ui.find((n) => n.props['aria-label'] === 'Branch').props.onChange({ target: { value: 'other' } })
  assert.equal(ui.button('Save configuration').props.disabled, true)
  ui.button('Save configuration').props.onClick(); await tick()
  assert.equal(ui.configCalls.length, 1)
  assert.ok(ui.find((n) => n.type === 'div' && /hidden.*replacement/i.test(ui.text(n))))
  ui.find((n) => n.props['aria-label'] === 'Remote').props.onChange({ target: { value: '/srv/new.git' } })
  assert.equal(ui.button('Save configuration').props.disabled, false)
})

test('config request abort deadline leaves save retryable and can recover initial load', async () => {
  const ui = setup(); await tick()
  ui.configQueue.push('hang')
  ui.button('Save configuration').props.onClick(); await tick()
  assert.ok(ui.configCalls[1].options.signal)
  ui.expire(); await tick()
  assert.equal(ui.button('Save configuration').props.disabled, false)
  assert.ok(ui.find((n) => n.props.role === 'alert'))
  assert.equal(ui.notice(), undefined)
  ui.configQueue.push(response({ ok: true, accepted: true }), response({ ...status, remoteEditable: true }))
  ui.queue.push(response(status))
  ui.button('Save configuration').props.onClick(); await tick(); await tick()
  assert.equal(ui.notice(), 'Configuration saved and verified.')
})

test('initial read and post-save verification read both time out without enabling unknown defaults', async () => {
  const initial = setup({ configFailure: 'hang' }); await tick()
  initial.expire(); await tick(); await tick()
  assert.equal(initial.button('Save configuration').props.disabled, true)
  initial.button('Retry loading configuration').props.onClick(); await tick(); await tick()
  assert.equal(initial.button('Save configuration').props.disabled, false)
  initial.configQueue.push(response({ ok: true, accepted: true }), 'hang')
  initial.button('Save configuration').props.onClick(); await tick(); await tick()
  initial.expire(); await tick(); await tick()
  assert.equal(initial.notice(), undefined)
  assert.equal(initial.button('Save configuration').props.disabled, false)
  assert.ok(initial.find((n) => n.props.role === 'alert'))
})

test('config form loads empty values and warns about Pull overwriting profile patch', async () => {
  const ui = setup({ config: { ok: true, remote: '', branch: 'main', profile: '', remoteEditable: true } }); await tick()
  assert.equal(ui.find((n) => n.props['aria-label'] === 'Remote').props.value, '')
  assert.ok(ui.find((n) => n.type === 'div' && /profile patch.*Pull/i.test(ui.text(n))))
  assert.equal(ui.button('Save configuration').props.disabled, false)
})

test('config save disables sync, survives interrupted POST and verifies effective values', async () => {
  const ui = setup(); await tick()
  ui.find((n) => n.props['aria-label'] === 'Remote').props.onChange({ target: { value: 'https://example.com/config.git' } })
  const pending = deferred()
  ui.configQueue.push(pending.promise, response({ ok: true, remote: 'https://example.com/config.git', branch: 'main', profile: 'work', remoteEditable: true }))
  ui.queue.push(response(status))
  ui.button('Save configuration').props.onClick()
  assert.equal(ui.button('Push').props.disabled, true)
  assert.equal(ui.notice(), undefined)
  pending.resolve(Promise.reject(new Error('disconnected'))); await tick()
  assert.equal(ui.notice(), 'Configuration saved and verified.')
  assert.equal(ui.configCalls[1].options.method, 'POST')
  assert.equal(ui.configCalls[2].options?.method, undefined)
})

test('config save refuses to claim success on override and allows retry without masked prefill', async () => {
  const ui = setup({ config: { ok: true, remote: '', branch: 'main', profile: '', remoteEditable: false } }); await tick()
  const remote = ui.find((n) => n.props['aria-label'] === 'Remote')
  assert.equal(remote.props.value, '')
  remote.props.onChange({ target: { value: '/srv/new.git' } })
  ui.configQueue.push(response({ ok: false, code: 'E_CONFIG_SAVE', message: 'Configuration could not be saved.' }, false))
  ui.button('Save configuration').props.onClick(); await tick()
  assert.equal(ui.notice(), undefined)
  assert.equal(ui.button('Save configuration').props.disabled, false)
})

test('accepted save retries mismatched effective values and never calls it success', async () => {
  const ui = setup(); await tick()
  ui.find((n) => n.props['aria-label'] === 'Remote').props.onChange({ target: { value: '/srv/changed.git' } })
  ui.configQueue.push(response({ ok: true, accepted: true, verified: false }))
  ui.button('Save configuration').props.onClick()
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(ui.configCalls.length, 14)
  assert.equal(ui.notice(), undefined)
  assert.ok(ui.find((n) => n.props.role === 'alert'))
  assert.equal(ui.button('Save configuration').props.disabled, false)
})

test('push shows busy state, passes message, preserves success through refresh, then manual refresh clears it', async () => {
  const ui = setup(); await tick()
  ui.find((n) => n.props['aria-label'] === 'Commit message (optional)').props.onChange({ target: { value: 'my commit' } })
  const pending = deferred(); ui.queue.push(pending.promise)
  ui.button('Push').props.onClick()
  const progress = ui.find((n) => n.type === 'progress')
  assert.ok(progress, 'an indeterminate progress bar is visible during push')
  assert.equal(progress.props.value, undefined)
  assert.equal(ui.text(ui.button('Pushing…')), 'Pushing…')
  assert.ok(ui.find((n) => n.type === 'span' && ui.text(n) === 'Syncing…'))
  for (const n of ['Refresh', 'Preview pull', 'Apply pull', 'Pushing…']) assert.equal(ui.button(n).props.disabled, true)
  assert.equal(ui.find((n) => n.props['aria-label'] === 'Commit message (optional)').props.disabled, true)
  assert.equal(ui.calls[1].path, '/api/config-sync/push')
  assert.deepEqual(JSON.parse(ui.calls[1].options.body), { message: 'my commit' })
  const refreshing = deferred(); ui.queue.push(refreshing.promise)
  pending.resolve(response({ ok: true, text: 'Pushed successfully' })); await tick()
  assert.equal(ui.notice(), 'Push complete: the remote is updated.')
  assert.equal(ui.find((n) => n.type === 'progress'), undefined)
  assert.equal(ui.pre(), 'Pushed successfully')
  assert.equal(ui.button('Push').props.disabled, true)
  refreshing.resolve(response({ ...status, text: 'Updated status' })); await tick()
  assert.equal(ui.notice(), 'Push complete: the remote is updated.')
  assert.equal(ui.find((n) => n.type === 'progress'), undefined)
  assert.equal(ui.pre(), 'Pushed successfully')
  assert.equal(ui.button('Push').props.disabled, false)
  ui.queue.push(response({ ...status, text: 'Fresh status' }))
  ui.button('Refresh').props.onClick(); await tick()
  assert.equal(ui.notice(), undefined)
  assert.equal(ui.pre(), 'Fresh status')
})

test('preview busy state and no-op feedback, including Chinese locale', async () => {
  const ui = setup({ language: 'zh-CN' }); await tick()
  const pending = deferred(); ui.queue.push(pending.promise, response(status))
  ui.button('预览 Pull').props.onClick()
  assert.equal(ui.button('Pull 中…').props.disabled, true)
  assert.equal(ui.find((n) => n.type === 'progress').props['aria-label'], 'Pull 中…')
  assert.deepEqual(JSON.parse(ui.calls[1].options.body), { apply: false })
  pending.resolve(response({ ok: true, text: 'Already up to date.' })); await tick()
  assert.equal(ui.notice(), '已是最新，没有需要同步的改动。')
  assert.equal(ui.pre(), 'Already up to date.')
})

test('preview and apply success report distinct outcomes and confirm cancellation is inert', async () => {
  const ui = setup(); await tick()
  ui.queue.push(response({ ok: true, text: 'Nothing written.' }), response(status))
  ui.button('Preview pull').props.onClick(); await tick()
  assert.equal(ui.notice(), 'Preview complete.')
  assert.equal(ui.pre(), 'Nothing written.')
  ui.queue.push(response({ ok: true, text: 'Files applied' }), response(status))
  ui.button('Apply pull').props.onClick(); await tick()
  assert.deepEqual(JSON.parse(ui.calls[3].options.body), { apply: true })
  assert.equal(ui.notice(), 'Remote configuration applied. Restart DSH when convenient.')
  const cancelled = setup({ confirm: false }); await tick()
  cancelled.button('Apply pull').props.onClick(); await tick()
  assert.equal(cancelled.calls.length, 1)
  assert.equal(cancelled.notice(), undefined)
})

test('failure removes success feedback, displays error, and permits retry', async () => {
  const ui = setup(); await tick()
  ui.queue.push(response({ ok: true, text: 'Already up to date; nothing to commit.' }), response(status))
  ui.button('Push').props.onClick(); await tick()
  assert.equal(ui.notice(), 'Already up to date; nothing to sync.')
  ui.queue.push(response({ ok: false, code: 'E_PUSH', message: 'remote rejected' }, false))
  ui.button('Push').props.onClick(); await tick()
  assert.equal(ui.notice(), undefined)
  assert.ok(ui.find((n) => n.type === 'div' && ui.text(n).includes('E_PUSH — remote rejected')))
  assert.equal(ui.button('Push').props.disabled, false)
  assert.equal(ui.calls.length, 4)
})

test('a failed automatic status refresh leaves action success visible alongside the error', async () => {
  const ui = setup(); await tick()
  ui.queue.push(response({ ok: true, text: 'Pushed' }), response({ ok: false, code: 'E_STATUS', message: 'status failed' }, false))
  ui.button('Push').props.onClick(); await tick()
  assert.equal(ui.notice(), 'Push complete: the remote is updated.')
  assert.ok(ui.find((n) => n.type === 'div' && ui.text(n).includes('E_STATUS — status failed')))
  assert.equal(ui.pre(), 'Pushed')
})
