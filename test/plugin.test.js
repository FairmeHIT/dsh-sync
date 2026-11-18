import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { apply, name, parseApplyInput, parsePushInput } from '../index.js'

function runEffect(execute, disposers) {
  const result = execute()
  if (result && typeof result[Symbol.iterator] === 'function') {
    for (const disposer of result) disposers.push(disposer)
  } else if (typeof result === 'function') {
    disposers.push(result)
  }
}

function fakeScope(commands, disposers) {
  return {
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    effect(execute) {
      runEffect(execute, disposers)
    },
  }
}

function fakeConnectionScope(routes, disposers) {
  return {
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    },
    effect(execute) {
      runEffect(execute, disposers)
    },
  }
}

function fakeContext({ withCommands = true, withConnection = false } = {}) {
  const tools = []
  const commands = []
  const routes = []
  const disposers = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    logger: { info() {} },
    effect(execute) {
      runEffect(execute, disposers)
    },
    inject(services, callback) {
      for (const service of services) {
        assert.ok(['commands', 'connection'].includes(service), `unexpected service ${service}`)
      }
      if (services.includes('commands') && withCommands) {
        callback(fakeScope(commands, disposers))
      }
      if (services.includes('connection') && withConnection) {
        callback(fakeConnectionScope(routes, disposers))
      }
    },
  }
  return { ctx, tools, commands, routes, disposers }
}

describe('plugin entry', () => {
  test('exports a stable package name', () => {
    assert.equal(name, 'dsh-config-git-sync')
  })

  test('registers three model tools with string output', () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, {})
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'config_sync_pull',
      'config_sync_push',
      'config_sync_status',
    ])
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 20, `${tool.name} needs a description`)
      assert.equal(typeof tool.execute, 'function')
      assert.equal(tool.output.schema.type, 'string')
    }
    const pushTool = tools.find((tool) => tool.name === 'config_sync_push')
    assert.equal(pushTool.parameters.properties.force.type, 'boolean')
    assert.equal(pushTool.parameters.properties.message.type, 'string')
  })

  test('tools surface stable error codes instead of bare messages', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, {})
    for (const toolName of ['config_sync_status', 'config_sync_push', 'config_sync_pull']) {
      const tool = tools.find((candidate) => candidate.name === toolName)
      await assert.rejects(tool.execute({}, {}), (error) => {
        assert.match(error.message, /^E_CONFIG:/)
        assert.equal(error.code, 'E_CONFIG')
        return true
      })
    }
  })

  test('registers lowercase slash commands without a leading slash', () => {
    const { ctx, commands } = fakeContext()
    apply(ctx, {})
    assert.deepEqual(commands.map((command) => command.name).sort(), [
      'sync-pull',
      'sync-push',
      'sync-status',
    ])
    for (const command of commands) {
      assert.match(command.name, /^[a-z0-9-]+$/)
      assert.equal(typeof command.handler, 'function')
    }
  })

  test('slash commands report config errors instead of throwing', async () => {
    const { ctx, commands } = fakeContext()
    apply(ctx, {})
    const pullCommand = commands.find((command) => command.name === 'sync-pull')
    const result = await pullCommand.handler({ rawInput: 'apply' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /^E_CONFIG:/)
  })

  test('push command tolerates a missing invocation payload', async () => {
    const { ctx, commands } = fakeContext()
    apply(ctx, {})
    const pushCommand = commands.find((command) => command.name === 'sync-push')
    const result = await pushCommand.handler()
    assert.equal(result.kind, 'error')
    assert.match(result.text, /^E_CONFIG:/)
  })

  test('registers five HTTP routes when a connection exists', () => {
    const { ctx, routes, disposers } = fakeContext({ withConnection: true })
    apply(ctx, {})
    assert.deepEqual(routes.map((route) => route.path).sort(), [
      '/api/config-sync/config',
      '/api/config-sync/probe',
      '/api/config-sync/pull',
      '/api/config-sync/push',
      '/api/config-sync/status',
    ])
    for (const route of routes) {
      assert.equal(typeof route.fetch, 'function')
      assert.equal(route.requestBody, 'buffered')
    }
    assert.equal(disposers.length, 11)
  })

  test('loads without the optional commands service', () => {
    const { ctx, tools, disposers } = fakeContext({ withCommands: false })
    assert.doesNotThrow(() => apply(ctx, {}))
    assert.equal(tools.length, 3)
    assert.equal(disposers.length, 3)
  })

  test('registers tools inside a Cordis effect for cleanup', () => {
    const { ctx, disposers } = fakeContext()
    apply(ctx, {})
    assert.equal(disposers.length, 6)
    for (const dispose of disposers) assert.equal(typeof dispose, 'function')
  })
})

describe('parseApplyInput', () => {
  test('accepts the separator space the command runtime includes', () => {
    assert.equal(parseApplyInput(' apply'), true)
    assert.equal(parseApplyInput('  APPLY  '), true)
    assert.equal(parseApplyInput('apply now'), true)
  })

  test('keeps preview mode for empty or different input', () => {
    assert.equal(parseApplyInput(''), false)
    assert.equal(parseApplyInput(undefined), false)
    assert.equal(parseApplyInput('applynow'), false)
    assert.equal(parseApplyInput('apply-ish'), false)
    assert.equal(parseApplyInput('dry-run'), false)
  })
})

describe('parsePushInput', () => {
  test('extracts a leading force flag', () => {
    assert.deepEqual(parsePushInput('--force'), { force: true, message: '' })
    assert.deepEqual(parsePushInput(' -f fix config '), { force: true, message: 'fix config' })
    assert.deepEqual(parsePushInput('--force   fix config'), { force: true, message: 'fix config' })
  })

  test('does not treat force-like words inside a message as flags', () => {
    assert.deepEqual(parsePushInput('fix -f config'), { force: false, message: 'fix -f config' })
    assert.deepEqual(parsePushInput('fix config --force'), {
      force: false,
      message: 'fix config --force',
    })
  })

  test('keeps an ordinary commit message', () => {
    assert.deepEqual(parsePushInput('update desktop plugins'), {
      force: false,
      message: 'update desktop plugins',
    })
    assert.deepEqual(parsePushInput(''), { force: false, message: '' })
    assert.deepEqual(parsePushInput(undefined), { force: false, message: '' })
  })
})
