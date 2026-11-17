// Browser half of the config-sync plugin: a card on the bundle page with the
// remote status and Pull/Push controls. Hand-written in the lazy-CJS bundle
// protocol so it needs no build step and no DSH client dependency beyond React.
window.__ModuleLoader__.load({
  id: 'dsh-config-git-sync',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var PACKAGE_NAME = 'dsh-config-git-sync'
    var ROUTES = {
      status: '/api/config-sync/status',
      push: '/api/config-sync/push',
      pull: '/api/config-sync/pull',
      config: '/api/config-sync/config',
    }

    var zh =
      typeof navigator !== 'undefined' && /^zh/i.test(String(navigator.language || ''))

    var copy = zh
      ? {
          title: '配置同步',
          subtitle: '一键换机，多端同步 · 私有 Git 同步插件清单与配置',
          remote: '远端',
          branch: '分支',
          profile: 'Profile',
          refresh: '刷新',
          preview: '预览 Pull',
          apply: '应用 Pull',
          push: 'Push',
          syncBusy: '同步中…',
          pullBusy: 'Pull 中…',
          pushBusy: 'Push 中…',
          pushDone: 'Push 完成：远端已更新。',
          pullDone: 'Pull 完成。',
          previewDone: '预览完成。',
          upToDate: '已是最新，没有需要同步的改动。',
          message: '提交信息（可选）',
          messageHint: '留空则自动生成',
          status: '状态',
          loading: '正在读取远端状态…',
          empty: '还没有状态。点“刷新”读取。',
          noRemote: '还没有配置远端。请在上方填写仓库地址并保存。',
          retryConfig: '重试读取配置',
          hiddenRemote: '现有远端已隐藏；必须填写非空替换地址才能保存，不能仅修改分支或 Profile。',
          save: '保存配置', saving: '保存并核对中…', saved: '配置已保存并核对生效。',
          saveError: '无法确认配置已生效。请检查高优先级覆盖或稍后重试。',
          configWarning: '配置保存在 profile patch 中，Pull 可能覆盖这些设置。仅填写不含凭据的 HTTPS / SSH 地址，使用 Git 凭据管理器或 SSH；本地路径指服务器上当前信任用户可访问的路径。',
          applyConfirm: 'Pull 会覆盖本机受管文件。应用前会自动写快照。继续？',
          applied: '已应用远端配置。建议重启 DSH。',
          requestTimeout: '请求超时，请稍后重试。',
          error: '操作失败',
        }
      : {
          title: 'Config sync',
          subtitle: 'One-click migration, multi-device sync · private Git for plugin manifest and config',
          remote: 'Remote',
          branch: 'Branch',
          profile: 'Profile',
          refresh: 'Refresh',
          preview: 'Preview pull',
          apply: 'Apply pull',
          push: 'Push',
          syncBusy: 'Syncing…',
          pullBusy: 'Pulling…',
          pushBusy: 'Pushing…',
          pushDone: 'Push complete: the remote is updated.',
          pullDone: 'Pull complete.',
          previewDone: 'Preview complete.',
          upToDate: 'Already up to date; nothing to sync.',
          message: 'Commit message (optional)',
          messageHint: 'Leave blank to auto-generate',
          status: 'Status',
          loading: 'Reading the remote status…',
          empty: 'No status yet. Choose Refresh.',
          noRemote: 'No remote configured. Enter a repository above and save.',
          retryConfig: 'Retry loading configuration',
          hiddenRemote: 'The existing remote is hidden. Enter a nonempty replacement before saving; branch-only edits cannot preserve a hidden remote.',
          save: 'Save configuration', saving: 'Saving and verifying…', saved: 'Configuration saved and verified.',
          saveError: 'Could not verify effective configuration. Check higher-priority overrides or retry after reload.',
          configWarning: 'Saved in the profile patch; Pull may overwrite these settings. Use credential-free HTTPS / SSH with Git credential manager or SSH. Local paths refer to the server and its currently trusted user.',
          applyConfirm:
            'Pull will overwrite managed files on this machine. A snapshot is written first. Continue?',
          applied: 'Remote configuration applied. Restart DSH when convenient.',
          requestTimeout: 'The request timed out. Please retry.',
          error: 'Request failed',
        }

    async function request(path, options) {
      // Every card request carries a deadline so a stalled fetch can never
      // freeze the card in a busy/loading state. Sync operations can take
      // minutes on slow remotes; reads still finish quickly.
      var controller = new AbortController()
      var timeoutMs = options && options.timeoutMs
      var timer = setTimeout(function () { controller.abort() }, timeoutMs || 90000)
      var optionsWithSignal = { ...(options || {}), signal: controller.signal }
      delete optionsWithSignal.timeoutMs
      var response
      try {
        response = await fetch(path, optionsWithSignal)
      } catch (error) {
        clearTimeout(timer)
        // Only a deadline abort becomes a timeout error. Other transport
        // failures must propagate unchanged: saveConfig tolerates code-less
        // transport loss while the plugin reconciles, and callers display
        // the original message.
        if (error && (error.name === 'AbortError' || controller.signal.aborted)) {
          var failure = new Error(copy.requestTimeout)
          failure.code = 'E_TIMEOUT'
          throw failure
        }
        throw error
      }
      clearTimeout(timer)
      var data
      try {
        data = await response.json()
      } catch {
        throw new Error('The config-sync route returned a non-JSON response.')
      }
      if (!response.ok || data.ok === false) {
        var failure = new Error(data.message || 'The config-sync request failed.')
        failure.code = data.code || 'E_HTTP'
        throw failure
      }
      return data
    }

    async function configRequest(options) {
      var controller = new AbortController()
      var timer
      var timeout = new Promise(function (_resolve, reject) {
        timer = setTimeout(function () {
          controller.abort()
          var error = new Error(copy.saveError)
          error.code = 'E_CONFIG_TIMEOUT'
          reject(error)
        }, 15000)
      })
      try {
        return await Promise.race([request(ROUTES.config, { ...options, signal: controller.signal }), timeout])
      } finally {
        clearTimeout(timer)
      }
    }

    function buttonStyle(primary) {
      return {
        appearance: 'none',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1.4,
        cursor: 'pointer',
        border: '1px solid ' + (primary ? 'transparent' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))'),
        borderRadius: '8px',
        padding: '6px 12px',
        background: primary
          ? 'var(--dsw-alias-label-primary, currentColor)'
          : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.06))',
        color: primary ? 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.05))' : 'inherit',
      }
    }

    function field(label, value) {
      return h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          {
            style: {
              color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))',
              fontSize: '12px',
              marginBottom: '2px',
            },
          },
          label,
        ),
        h(
          'div',
          {
            title: value,
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              fontSize: '12px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          value || '—',
        ),
      )
    }

    function Card() {
      var state = React.useState({
        loading: true,
        busy: false,
        busyAction: '',
        data: null,
        error: null,
        notice: '',
        result: '',
        message: '',
        draft: { remote: '', branch: 'main', profile: '' },
        configLoading: true,
        configReady: false,
        remoteHidden: false,
        saving: false,
        configError: null,
      })
      var view = state[0]
      var setView = state[1]

      var load = React.useCallback(async function (preserveResult) {
        setView(function (current) {
          return {
            ...current,
            loading: true,
            error: null,
            result: preserveResult ? current.result : '',
            notice: preserveResult ? current.notice : '',
          }
        })
        try {
          var data = await request(ROUTES.status)
          setView(function (current) {
            return { ...current, loading: false, data: data, error: null }
          })
        } catch (error) {
          setView(function (current) {
            return { ...current, loading: false, error: error }
          })
        }
      }, [])

      async function loadConfig() {
        setView(function (current) { return { ...current, configLoading: true, configReady: false, configError: null } })
        try {
          var data = await configRequest()
          setView(function (current) { return { ...current, configLoading: false, configReady: true, remoteHidden: data.remoteEditable === false, draft: { remote: data.remoteEditable === false ? '' : data.remote, branch: data.branch, profile: data.profile } } })
        } catch {
          setView(function (current) { return { ...current, configLoading: false, configReady: false, configError: copy.saveError } })
        }
      }

      React.useEffect(
        function () {
          load(false)
          loadConfig()
        },
        [load],
      )

      async function run(path, body, confirmText, action) {
        if (confirmText && !window.confirm(confirmText)) return
        setView(function (current) {
          return { ...current, busy: true, busyAction: action, error: null, notice: '', result: '' }
        })
        try {
          var data = await request(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            // Push/pull can take minutes on slow remotes or large profiles.
            timeoutMs: 600000,
          })
          var text = data.text || ''
          // The server reports the no-change outcome as a structured field;
          // the regex is only a fallback for older plugin instances.
          var notice = data.upToDate === true || /^Already up to date(?:; nothing to commit|\.)\.?$/im.test(text)
            ? copy.upToDate
            : action === 'push'
              ? copy.pushDone
              : action === 'apply'
                ? copy.applied
                : copy.previewDone
          setView(function (current) {
            return { ...current, busy: false, busyAction: '', result: text, notice: notice }
          })
          await load(true)
        } catch (error) {
          setView(function (current) {
            return { ...current, busy: false, busyAction: '', error: error, notice: '' }
          })
        }
      }

      async function saveConfig() {
        if (view.busy || view.saving || view.configLoading || !view.configReady || (view.remoteHidden && !view.draft.remote.trim())) return
        var desired = { remote: view.draft.remote.trim(), branch: view.draft.branch.trim() || 'main', profile: view.draft.profile.trim() }
        setView(function (current) { return { ...current, saving: true, configError: null, notice: '' } })
        try {
          try {
            await configRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(desired) })
          } catch (error) {
            // Transport loss is expected during plugin reconciliation, not success.
            // An explicit server rejection is final and must not be hidden by GET.
            if (error.code) throw error
          }
          var verified = null
          // Give a slow plugin reload time to surface the saved values: poll
          // for up to ~40 attempts x 500ms (~20s) instead of giving up at 6s.
          for (var attempt = 0; attempt < 40; attempt++) {
            if (attempt) await new Promise(function (resolve) { setTimeout(resolve, 500) })
            try {
              var effective = await configRequest()
              if (effective.remoteEditable !== false && effective.remote === desired.remote && effective.branch === desired.branch && effective.profile === desired.profile) { verified = effective; break }
            } catch (error) {
              if (error.code === 'E_CONFIG_TIMEOUT') throw error
              /* plugin may still be restarting */
            }
          }
          if (!verified) throw new Error(copy.saveError)
          setView(function (current) { return { ...current, saving: false, remoteHidden: false, notice: copy.saved, data: { ...current.data, ...verified } } })
          await load(true)
        } catch (error) {
          // Surface the server's own rejection code/message (E_CONFIG_INPUT,
          // E_CONFIG_BUSY, …) instead of a generic string that hides the cause.
          setView(function (current) {
            return { ...current, saving: false, configError: (error && (error.code || error.message)) ? (error.code ? error.code + ' — ' : '') + error.message : copy.saveError, notice: '' }
          })
        }
      }

      var data = view.data || {}
      var disabled = view.busy || view.loading || view.saving
      // A stalled fetch must never lock the user out of Refresh: only a sync
      // action or config save disables it, so a hung status read can be retried.
      var refreshDisabled = view.busy || view.saving
      var statusText = view.result || data.text || ''
      var error = view.error
      var hint =
        error && error.code === 'E_CONFIG' ? copy.noRemote : ''

      return h(
        'div',
        {
          style: {
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32))',
            borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.04))',
            padding: '14px 16px',
            display: 'grid',
            gap: '12px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '14px', fontWeight: 600 } }, copy.title),
            h(
              'div',
              {
                style: {
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))',
                  fontSize: '13px',
                  lineHeight: 1.5,
                },
              },
              copy.subtitle,
            ),
          ),
          h(
            'span',
            {
              style: {
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32))',
                borderRadius: '999px',
                padding: '2px 8px',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))',
                whiteSpace: 'nowrap',
              },
            },
            view.loading ? '…' : view.busy ? copy.syncBusy : copy.status,
          ),
        ),
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)',
              gap: '10px 16px',
            },
          },
          field(copy.remote, data.remote),
          field(copy.branch, data.branch),
          field(copy.profile, data.profile),
        ),
        h('div', { style: { display: 'grid', gap: '8px' } },
          h('div', { style: { fontSize: '12px', lineHeight: 1.5 } }, copy.configWarning),
          ['remote', 'branch', 'profile'].map(function (key) {
            return h('label', { key: key, style: { display: 'grid', gap: '4px' } },
              copy[key],
              h('input', {
                type: 'text', 'aria-label': copy[key], value: view.draft[key],
                maxLength: key === 'remote' ? 2048 : key === 'branch' ? 200 : 100,
                autoComplete: 'off', spellCheck: false,
                disabled: disabled || view.configLoading || !view.configReady,
                onChange: function (event) {
                  var value = event.target.value
                  setView(function (current) { return { ...current, draft: { ...current.draft, [key]: value } } })
                },
                style: { width: '100%', boxSizing: 'border-box', padding: '6px 10px', color: 'inherit', background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))', borderRadius: '8px' },
              }),
            )
          }),
          view.remoteHidden ? h('div', { style: { fontSize: '12px' } }, copy.hiddenRemote) : null,
          !view.configReady ? h('button', { type: 'button', disabled: disabled || view.configLoading, onClick: loadConfig, style: buttonStyle(false) }, copy.retryConfig) : null,
          h('button', { type: 'button', disabled: disabled || view.configLoading || !view.configReady || (view.remoteHidden && !view.draft.remote.trim()), onClick: saveConfig, style: buttonStyle(false) }, view.saving ? copy.saving : copy.save),
          view.configError ? h('div', { role: 'alert' }, view.configError) : null,
        ),
        error
          ? h(
              'div',
              {
                style: {
                  border: '1px solid var(--dsw-alias-border-warning, rgba(190,120,20,.45))',
                  borderRadius: '8px',
                  padding: '8px 10px',
                  fontSize: '13px',
                  lineHeight: 1.5,
                },
              },
              h('strong', null, copy.error + ': '),
              (error.code ? error.code + ' — ' : '') + error.message,
              hint ? h('div', { style: { marginTop: '4px' } }, hint) : null,
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } },
          h(
            'button',
            {
              type: 'button',
              disabled: refreshDisabled,
              onClick: function () {
                load(false)
              },
              style: buttonStyle(false),
            },
            copy.refresh,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: disabled,
              onClick: function () {
                run(ROUTES.pull, { apply: false }, null, 'preview')
              },
              style: buttonStyle(false),
            },
            view.busyAction === 'preview' ? copy.pullBusy : copy.preview,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: disabled,
              onClick: function () {
                run(ROUTES.pull, { apply: true }, copy.applyConfirm, 'apply')
              },
              style: buttonStyle(false),
            },
            view.busyAction === 'apply' ? copy.pullBusy : copy.apply,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: disabled,
              onClick: function () {
                run(ROUTES.push, { message: view.message }, null, 'push')
              },
              style: buttonStyle(true),
            },
            view.busyAction === 'push' ? copy.pushBusy : copy.push,
          ),
          h(
            'input',
            {
              type: 'text',
              value: view.message,
              maxLength: 500,
              placeholder: copy.messageHint,
              'aria-label': copy.message,
              disabled: disabled,
              onChange: function (event) {
                var value = event.target.value
                setView(function (current) {
                  return { ...current, message: value }
                })
              },
              style: {
                flex: '1 1 200px',
                minWidth: '160px',
                font: 'inherit',
                fontSize: '13px',
                lineHeight: 1.4,
                padding: '6px 10px',
                color: 'inherit',
                background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
                borderRadius: '8px',
              },
            },
          ),
        ),
        view.busy
          ? h('progress', {
              'aria-label': view.busyAction === 'push' ? copy.pushBusy : copy.pullBusy,
              style: { width: '100%', height: '6px', accentColor: 'var(--dsw-alias-label-primary, currentColor)' },
            })
          : null,
        view.notice
          ? h(
              'div',
              {
                role: 'status',
                style: {
                  border: '1px solid var(--dsw-alias-border-success, rgba(40,160,90,.45))',
                  borderRadius: '8px',
                  background: 'rgba(40,160,90,.08)',
                  padding: '8px 10px',
                  fontSize: '13px',
                  lineHeight: 1.5,
                  fontWeight: 600,
                },
              },
              view.notice,
            )
          : null,
        h(
          'div',
          null,
          h(
            'div',
            {
              style: {
                color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))',
                fontSize: '12px',
                marginBottom: '4px',
              },
            },
            copy.status,
          ),
          h(
            'pre',
            {
              style: {
                margin: 0,
                maxHeight: '260px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                fontSize: '12px',
                lineHeight: 1.55,
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
              },
            },
            statusText || (view.loading ? copy.loading : copy.empty),
          ),
        ),
      )
    }

    function SettingsPage() {
      return h('div', { style: { maxWidth: '760px' } }, h(Card))
    }

    function apply(ctx) {
      if (typeof ctx?.inject !== 'function') return
      ctx.inject(['slots'], function (scope) {
        if (typeof scope.slots?.inject !== 'function') return
        scope.slots.inject('plugins.bundle.config', function* () {
          yield scope.slots.register(
            { name: 'plugins.bundle.config', key: PACKAGE_NAME, order: 20 },
            Card,
          )
        })
        scope.slots.inject('settings.section', function* () {
          yield scope.slots.register(
            {
              name: 'settings.section',
              id: PACKAGE_NAME,
              order: 20,
              label: copy.title,
            },
            SettingsPage,
          )
        })
      })
    }

    exports.apply = apply
    exports.inject = []
    exports.__card = { ROUTES, request }
    return module.exports
  },
})
