import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config, PACKAGE_NAME, normalizeConfig, resolveDshHome } from './src/config.js'
import { formatError, toToolError } from './src/errors.js'
import { createHttpRoutes } from './src/http.js'
import { createConfigEditor } from './src/remote-config.js'
import { pull, pullReport, push, status, statusReport, testConnection } from './src/sync.js'
import { checkUpdate, createManagerProbe, readUpdateState, startUpdate } from './src/update.js'
import { readActivity } from './src/activity.js'
import { isLocked } from './src/lock.js'

export const name = PACKAGE_NAME
export const inject = ['tools']
export { Config }

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function commandResult(run) {
  return async (invocation) => {
    try {
      return { kind: 'success', text: await run(invocation ?? {}) }
    } catch (error) {
      return { kind: 'error', text: formatError(error) }
    }
  }
}

/**
 * Wrap a registration in a Cordis effect so tools and commands are disposed
 * with the plugin. Older contexts without `effect` still work.
 */
function withEffect(ctx, label, register) {
  if (typeof ctx.effect === 'function') {
    ctx.effect(function* () {
      for (const disposer of register()) yield disposer
    }, label)
    return
  }
  register()
}

/**
 * The command runtime passes the text after the command name verbatim,
 * including the separating space. Treat "apply" as a whole word only — a
 * hyphenated or glued form (e.g. "apply-ish", "applynow") must not trigger
 * the destructive path.
 */
export function parseApplyInput(rawInput) {
  return /^apply(?:\s|$)/i.test(String(rawInput ?? '').trim())
}

/** Parse `/sync-push [--force] [message]`; only leading flags are commands. */
export function parsePushInput(rawInput) {
  let rest = String(rawInput ?? '').trim()
  let force = false
  const match = /^(?:--force|-f)(?:\s+|$)/.exec(rest)
  if (match) {
    force = true
    rest = rest.slice(match[0].length)
  }
  return { force, message: rest.trim() }
}

/** Parse `/sync-pull [apply] [--force]`; `apply` still has to come first. */
export function parsePullInput(rawInput) {
  const apply = parseApplyInput(rawInput)
  const force = /(?:^|\s)(?:--force|-f)(?:\s|$)/i.test(String(rawInput ?? ''))
  return { apply, force }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = ctx.logger?.info ? (message) => ctx.logger.info(message) : () => {}

  const tools = [
    defineTool({
      name: 'config_sync_status',
      description:
        'Compare this DeepSeek Harness profile with the configured Git remote. Fetches the remote branch and reports file and plugin differences plus whether the remote moved since this machine last synced. Read-only for the local profile; never touches credentials.',
      parameters: {},
      output: textOutput,
      async execute(_args, exec) {
        try {
          return await status(config, { signal: exec?.signal })
        } catch (error) {
          throw toToolError(error)
        }
      },
    }),
    defineTool({
      name: 'config_sync_push',
      description:
        'Publish this profile package.json and cordis.patch.yml to the configured Git remote. Refuses to overwrite remote changes made since this machine last synced unless force is true. Credentials are never included. Ask the user before calling it if they did not request a push.',
      parameters: {
        message: { type: 'string', description: 'Optional Git commit message.' },
        force: {
          type: 'boolean',
          description:
            "Overwrite the remote even though another machine changed it since this machine's last sync. Use only after the user reviewed /sync-status.",
        },
      },
      output: textOutput,
      async execute(args, exec) {
        try {
          return await push(config, {
            message: args.message,
            force: args.force === true,
            signal: exec?.signal,
          })
        } catch (error) {
          throw toToolError(error)
        }
      },
    }),
    defineTool({
      name: 'config_sync_pull',
      description:
        'Fetch package.json and cordis.patch.yml from the configured Git remote. Defaults to a dry run. Set apply=true only after the user confirms, because it overwrites local files after writing a pre-restore snapshot. A pull that would remove most of the plugin list is refused unless force=true; pass expectedCommit from the preview so the apply cannot land on content the user never reviewed.',
      parameters: {
        apply: {
          type: 'boolean',
          description: 'Write the remote files to this machine. Default false (dry run).',
        },
        force: {
          type: 'boolean',
          description:
            'Apply even though the remote would remove every plugin or most of them. Only after the user explicitly accepted that removal.',
        },
        expectedCommit: {
          type: 'string',
          description:
            'Commit the user reviewed in the preview. The apply is refused with E_STALE_PREVIEW if the remote branch moved since.',
        },
      },
      output: textOutput,
      async execute(args, exec) {
        try {
          return await pull(config, {
            apply: args.apply === true,
            force: args.force === true,
            expectedCommit: args.expectedCommit,
            signal: exec?.signal,
          })
        } catch (error) {
          throw toToolError(error)
        }
      },
    }),
  ]

  withEffect(ctx, 'config-sync tools', () => tools.map((tool) => ctx.tools.register(tool)))

  // Slash commands are optional: without the commands service the tools still work.
  ctx.inject(['commands'], (scope) => {
    withEffect(scope, 'config-sync commands', () => [
      scope.commands.register({
        name: 'sync-status',
        description: 'Show differences between this profile and the config-sync Git remote.',
        handler: commandResult((invocation) => {
          log('[config-sync] status')
          return status(config, { signal: invocation?.signal })
        }),
      }),
      scope.commands.register({
        name: 'sync-push',
        description: 'Push package.json and cordis.patch.yml to the config-sync Git remote.',
        input: { hint: '[--force] [commit message]', attachments: false },
        handler: commandResult((invocation) => {
          const { force, message } = parsePushInput(invocation?.rawInput)
          log(`[config-sync] push force=${force}`)
          return push(config, { force, message, signal: invocation?.signal })
        }),
      }),
      scope.commands.register({
        name: 'sync-pull',
        description:
          'Preview or apply profile files from the config-sync Git remote. Use "apply" to write; add --force only to accept a pull that removes most plugins.',
        input: { hint: 'apply [--force]', attachments: false },
        handler: commandResult((invocation) => {
          const { apply: shouldApply, force } = parsePullInput(invocation?.rawInput)
          log(`[config-sync] pull apply=${shouldApply} force=${force}`)
          return pull(config, { apply: shouldApply, force, signal: invocation?.signal })
        }),
      }),
    ])
  })

  // The Plugins-page card is a web feature. Keep it optional so the same host
  // bundle still works in headless and CLI contexts without a connection.
  ctx.inject(['connection'], (scope) => {
    if (typeof scope.connection?.fetch?.register !== 'function') return
    // The plugin manager owns installation and rollback, and arrives with the
    // web bundles. It is a lazy service, so a one-shot read on the outer context
    // misses it: probe every context we can see and let Cordis start it.
    const managers = createManagerProbe(ctx, { context: scope })
    const getManager = () => managers.get()
    const ensureManager = () => managers.ensure()
    const routes = createHttpRoutes(
      config,
      {
        status,
        statusReport,
        push,
        pull,
        pullReport,
        probe: testConnection,
        isBusy: () => isLocked(resolveDshHome(config)),
        readActivity: () => readActivity(config),
        checkUpdate: (current) => checkUpdate(current, { getManager }),
        startUpdate: (current) => startUpdate(current, { getManager, ensureManager }),
        readUpdateState: (current) => readUpdateState(current),
      },
      createConfigEditor(ctx),
    )
    withEffect(scope, 'config-sync HTTP routes', () =>
      routes.map((route) => scope.connection.fetch.register(route)),
    )
  })
}
