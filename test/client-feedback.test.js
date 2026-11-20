import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const status = { ok: true, remote: 'repo', branch: 'main', profile: 'work', text: 'Status output' }
const response = (data, ok = true) => ({ ok, json: async () => data })
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function setup({ language = 'en', configFailure = false, update = null, updateState = null, config = { ...status, remoteEditable: true, persistence: 'profile-patch' } } = {}) {
  let current, initial = true, Card, exported
  const effects = []
  const calls = [], queue = [], configCalls = [], configQueue = []
  const updateCalls = [], updateQueue = [], stateCalls = [], stateQueue = []
  const timers = new Map(); let timerId = 0
  const deadlines = []
  const upToDateCheck = { ok: true, supported: true, current: '0.7.2', latest: '0.7.2', available: false }
  // Seeded but not consumed on mount: the version check is lazy now.
  if (update !== null) updateQueue.push(update)
  if (updateState !== null) stateQueue.push(updateState)
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState(value) {
      if (initial) current = value
      return [current, (next) => { current = typeof next === 'function' ? next(current) : next }]
    },
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
    useEffect(fn) { if (initial) effects.push(fn) },
  }
  const window = { __ModuleLoader__: { load(def) { exported = def.factory(() => React) } } }
  const stall = (options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  const settle = (next, options) => {
    if (next === 'hang') return stall(options)
    if (next === 'reject') return Promise.reject(new Error('offline'))
    return Promise.resolve(next)
  }
  const fetch = (path, options) => {
    if (path === '/api/config-sync/config') {
      configCalls.push({ path, options })
      if (configFailure === true && configCalls.length === 1) return Promise.reject(new Error('offline'))
      if (configFailure === 'hang' && configCalls.length === 1) return stall(options)
      return settle(configQueue.length ? configQueue.shift() : response(config), options)
    }
    if (path === '/api/config-sync/update') {
      updateCalls.push({ path, options })
      const post = options?.method === 'POST'
      if (post) return Promise.resolve(updateQueue.length ? updateQueue.shift() : response({ ok: true, accepted: true }))
      return settle(updateQueue.length ? updateQueue.shift() : response(upToDateCheck), options)
    }
    if (path === '/api/config-sync/update-state') {
      stateCalls.push({ path, options })
      return settle(stateQueue.length ? stateQueue.shift() : response({ ok: true, update: null }), options)
    }
    calls.push({ path, options })
    assert.ok(queue.length, `unexpected request: ${path}`)
    return settle(queue.shift(), options)
  }
  new Function('window', 'navigator', 'fetch', 'setTimeout', 'clearTimeout', source)(window, { language }, fetch, (resolve, ms) => {
    if (ms === 500) { resolve(); return 0 }
    deadlines.push(ms)
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
  const dialog = () => find((n) => n.props.role === 'dialog')
  const more = () => { const node = find((n) => n.type === 'details' && n.props.className === 'dcfg-more'); assert.ok(node, 'more details'); return node }
  const body = (call) => JSON.parse(call.options.body)
  queue.push(response(status)); render(); effects.forEach((fn) => fn())
  return { calls, queue, configCalls, configQueue, updateCalls, updateQueue, stateCalls, stateQueue, render, find, text, button, notice, dialog, more, body, deadlines, expire: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()) } }
}

test('card opens with actions and expanded settings, and checks the version once', async () => {
  const ui = setup(); await tick()
  ui.button('Pull'); ui.button('Push')
  assert.equal(ui.more().props.open, true)
  assert.equal(ui.updateCalls.length, 1)
  assert.equal(ui.find((n) => n.props.role === 'dialog'), undefined)
})

test('the version check runs once even when More is toggled', async () => {
  const ui = setup({ update: response({ ok: true, supported: true, current: '0.7.2', latest: '0.7.3', available: true }) }); await tick()
  assert.equal(ui.updateCalls.length, 1)
  ui.button('Update to 0.7.3')
  ui.more().props.onToggle({ target: { open: true } })
  await tick()
  assert.equal(ui.updateCalls.length, 1)
})

test('pull only compares first and writes after the dialog is confirmed', async () => {
  const ui = setup(); await tick()
  ui.queue.push(
    response({ ok: true, profile: 'work', channel: 'work', text: 'Config sync pull (dry run)\n\n~ package.json' }),
    response({ ok: true, profile: 'work', channel: 'work', text: 'Config sync pull\napplied' }),
    response(status),
  )
  ui.button('Pull').props.onClick(); await tick()
  assert.equal(ui.calls.length, 2)
  assert.deepEqual(ui.body(ui.calls[1]), { apply: false })
  const box = ui.dialog()
  assert.ok(box)
  assert.match(ui.text(box), /package\.json/)
  assert.match(ui.text(box), /snapshot/i)
  assert.equal(ui.calls.length, 2, 'preview must not write')
  ui.button('Confirm').props.onClick(); await tick()
  assert.equal(ui.calls.length, 4)
  assert.deepEqual(ui.body(ui.calls[2]), { apply: true, expectedCommit: '', force: false })
  assert.match(ui.notice(), /applied|restart/i)
})

test('cancelling the pull dialog sends nothing', async () => {
  const ui = setup(); await tick()
  ui.queue.push(response({ ok: true, profile: 'work', channel: 'work', text: 'Config sync pull (dry run)\n~ package.json' }))
  ui.button('Pull').props.onClick(); await tick()
  assert.ok(ui.dialog())
  ui.button('Cancel').props.onClick(); await tick()
  assert.equal(ui.calls.length, 2)
  assert.equal(ui.dialog(), undefined)
})

test('a pull with no changes never opens the dialog', async () => {
  const ui = setup(); await tick()
  ui.queue.push(response({ ok: true, upToDate: true, text: 'Already up to date.' }), response(status))
  ui.button('Pull').props.onClick(); await tick()
  assert.equal(ui.calls.length, 3)
  assert.equal(ui.dialog(), undefined)
  assert.match(ui.notice(), /already up to date/i)
})

test('push opens its confirmation immediately and writes only on confirm', async () => {
  const ui = setup(); await tick()
  ui.button('Push').props.onClick(); await tick()
  assert.equal(ui.calls.length, 1)
  const box = ui.dialog()
  assert.ok(box)
  assert.match(ui.text(box), /remote branch/i)
  ui.find((n) => n.props['aria-label'] === 'Commit message (optional)').props.onChange({ target: { value: 'my commit' } })
  ui.queue.push(response({ ok: true, text: 'Pushed. Other machines can now run /sync-pull.' }), response(status))
  ui.button('Confirm').props.onClick(); await tick()
  assert.equal(ui.calls.length, 3)
  assert.deepEqual(ui.body(ui.calls[1]), { message: 'my commit', force: false })
  assert.match(ui.notice(), /push complete/i)
})

test('a refused push asks again with the diff and only then overwrites', async () => {
  const ui = setup(); await tick()
  ui.button('Push').props.onClick(); await tick()
  assert.equal(ui.calls.length, 1)
  ui.queue.push(
    response({
      ok: false,
      code: 'E_CONFLICT',
      message: 'remote already contains a manifest for profile "work" and this machine has never synced',
      details: {
        forceable: true,
        reason: 'never-synced',
        channel: 'work',
        remoteCommit: 'abc123',
        preview: 'This push would write these changes into the remote branch:\n~ package.json',
      },
    }),
    response({ ok: true, text: 'Pushed. Other machines can now run /sync-pull.' }),
    response(status),
  )
  ui.button('Confirm').props.onClick(); await tick()
  assert.deepEqual(ui.body(ui.calls[1]), { message: '', force: false })
  const box = ui.dialog()
  assert.ok(box, 'the conflict keeps a dialog open')
  assert.match(ui.text(box), /remote moved|moved since/i)
  assert.match(ui.text(box), /package\.json/)
  assert.match(ui.text(box), /overwrite the remote/i)
  assert.ok(ui.find((n) => n.props.role === 'alert') === undefined, 'the conflict is not an error banner')
  ui.button('Overwrite the remote').props.onClick(); await tick()
  assert.equal(ui.calls.length, 4)
  assert.deepEqual(ui.body(ui.calls[2]), { message: '', force: true })
  assert.match(ui.notice(), /push complete/i)
})

test('a forced push that still conflicts reports the failure instead of looping', async () => {
  const ui = setup(); await tick()
  ui.button('Push').props.onClick(); await tick()
  ui.queue.push(
    response({ ok: false, code: 'E_CONFLICT', message: 'first refusal', details: { forceable: true, preview: '~ package.json' } }),
    response({ ok: false, code: 'E_CONFLICT', message: 'second refusal', details: { forceable: true, preview: '~ package.json' } }),
  )
  ui.button('Confirm').props.onClick(); await tick()
  ui.button('Overwrite the remote').props.onClick(); await tick()
  assert.equal(ui.calls.length, 3, 'the forced push is not retried')
  assert.equal(ui.dialog(), undefined)
  assert.match(ui.text(ui.find((n) => n.props.role === 'alert')), /second refusal/)
})

test('a conflict without forceable details stays a plain error', async () => {
  const ui = setup(); await tick()
  ui.button('Push').props.onClick(); await tick()
  ui.queue.push(response({ ok: false, code: 'E_CONFLICT', message: 'no details here' }))
  ui.button('Confirm').props.onClick(); await tick()
  assert.equal(ui.dialog(), undefined)
  assert.match(ui.text(ui.find((n) => n.props.role === 'alert')), /no details here/)
})

test('a pull preview timeout stays retryable and nothing is written', async () => {
  const ui = setup(); await tick()
  ui.queue.push('hang')
  ui.button('Pull').props.onClick(); await tick()
  assert.equal(ui.find((n) => n.props.role === 'progressbar').props['aria-label'], 'Pulling…')
  assert.equal(ui.button('Pulling…').props.disabled, true)
  ui.expire(); await tick()
  assert.ok(ui.find((n) => n.props.role === 'alert'))
  assert.equal(ui.dialog(), undefined)
  assert.equal(ui.calls.length, 2)
  assert.equal(ui.button('Pull').props.disabled, false)
  assert.ok(ui.deadlines.includes(600000))
})

test('a held lock during the preview reports busy instead of failing', async () => {
  const ui = setup(); await tick()
  ui.queue.push(response({ ok: false, code: 'E_BUSY', message: 'Another sync is running.' }))
  ui.button('Pull').props.onClick(); await tick()
  assert.match(ui.notice(), /already running/i)
  assert.equal(ui.dialog(), undefined)
})

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

test('config save verifies the effective values before reporting success', async () => {
  const ui = setup(); await tick()
  ui.configQueue.push(response({ ok: true, accepted: true, verified: false }), response({ ...status, remoteEditable: true }))
  ui.queue.push(response(status))
  ui.button('Save configuration').props.onClick(); await tick(); await tick()
  assert.equal(ui.notice(), 'Configuration saved and verified.')
})

test('a pull adoption dialog names the remote directory it will map', async () => {
  const ui = setup({ config: { ok: true, remote: 'repo', branch: 'main', profile: 'web', remoteEditable: true } }); await tick()
  ui.queue.push(
    response({
      ok: true,
      profile: 'web',
      channel: 'desktop',
      adopted: true,
      text: 'Config sync pull (dry run)\n\nadopt: remote directory "desktop" -> local profile "web"',
    }),
  )
  ui.button('Pull').props.onClick(); await tick()
  const box = ui.dialog()
  assert.ok(box)
  assert.match(ui.text(box), /remote directory "desktop"/)
  assert.match(ui.text(box), /profile "web"/)
})

test('the card speaks Chinese when the client does', async () => {
  const ui = setup({ language: 'zh-CN' }); await tick()
  ui.button('拉取'); ui.button('推送')
  assert.equal(ui.text(ui.more().children[0]), '更多')
  assert.equal(ui.find((n) => n.props['aria-label'] === 'Profile').props.placeholder, '留空自动检测')
  ui.queue.push(response({ ok: true, upToDate: true, text: 'Already up to date.' }), response(status))
  ui.button('拉取').props.onClick(); await tick()
  assert.equal(ui.dialog(), undefined)
  assert.equal(ui.notice(), '已是最新，没有需要同步的改动。')
})

test('save, refresh and test connection share one action row', async () => {
  const ui = setup(); await tick()
  const row = ui.find((n) => n.type === 'div' && n.props.className === 'dcfg-moreline' && /Save configuration/.test(ui.text(n)))
  assert.ok(row, 'action row')
  assert.match(ui.text(row), /Refresh/)
  assert.match(ui.text(row), /Test connection/)
})

test('push confirmation input survives rerender and dialog cancel keeps the draft', async () => {
  const ui = setup(); await tick()
  ui.button('Push').props.onClick(); await tick()
  const input = () => ui.find((n) => n.props['aria-label'] === 'Commit message (optional)')
  input().props.onChange({ target: { value: 'kept message' } })
  assert.equal(input().props.value, 'kept message')
  ui.button('Cancel').props.onClick(); await tick()
  assert.equal(ui.dialog(), undefined)
  ui.button('Push').props.onClick(); await tick()
  assert.equal(input().props.value, 'kept message')
})

test('Test connection reports the probe result without opening a dialog', async () => {
  const ui = setup(); await tick()
  ui.more().props.onToggle({ target: { open: true } }); await tick()
  ui.queue.push(response({ ok: true, text: 'Connection test passed.' }), response(status))
  ui.button('Test connection').props.onClick(); await tick()
  assert.equal(ui.calls[1].path, '/api/config-sync/probe')
  assert.match(ui.notice(), /Connection test passed/)
  assert.equal(ui.dialog(), undefined)
})

test('a newer version updates in place, then asks for a reload', async () => {
  const ui = setup({ update: response({ ok: true, supported: true, current: '0.7.2', latest: '0.7.3', available: true }) }); await tick()
  ui.more().props.onToggle({ target: { open: true } }); await tick()
  assert.equal(ui.updateCalls.length, 1)
  ui.updateQueue.push(response({ ok: true, accepted: true }))
  ui.stateQueue.push(
    response({ ok: true, update: { status: 'running' } }),
    response({ ok: true, update: { status: 'done', from: '0.7.2', to: '0.7.3' } }),
  )
  ui.button('Update to 0.7.3').props.onClick(); await tick()
  assert.equal(ui.updateCalls.length, 2)
  assert.equal(ui.updateCalls[1].options.method, 'POST')
  assert.equal(ui.stateCalls.length, 1)
  ui.expire(); await tick()
  assert.equal(ui.stateCalls.length, 2)
  assert.match(ui.notice(), /Updated to 0\.7\.3/)
  ui.button('Reload page')
})
