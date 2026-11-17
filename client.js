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
    }

    var zh =
      typeof navigator !== 'undefined' && /^zh/i.test(String(navigator.language || ''))

    var copy = zh
      ? {
          title: '配置同步',
          subtitle: '通过私有 Git 仓库同步这个 profile 的插件清单',
          remote: '远端',
          branch: '分支',
          profile: 'Profile',
          refresh: '刷新',
          preview: '预览 Pull',
          apply: '应用 Pull',
          push: 'Push',
          message: '提交信息（可选）',
          messageHint: '留空则自动生成',
          status: '状态',
          loading: '正在读取远端状态…',
          empty: '还没有状态。点“刷新”读取。',
          noRemote: '还没有配置远端。请先在 ~/.dsh/cordis.patch.yml 的 config.remote 填写仓库地址。',
          applyConfirm: 'Pull 会覆盖本机受管文件。应用前会自动写快照。继续？',
          applied: '已应用远端配置。建议重启 DSH。',
          error: '操作失败',
        }
      : {
          title: 'Config sync',
          subtitle: 'Sync this profile through a private Git repository',
          remote: 'Remote',
          branch: 'Branch',
          profile: 'Profile',
          refresh: 'Refresh',
          preview: 'Preview pull',
          apply: 'Apply pull',
          push: 'Push',
          message: 'Commit message (optional)',
          messageHint: 'Leave blank to auto-generate',
          status: 'Status',
          loading: 'Reading the remote status…',
          empty: 'No status yet. Choose Refresh.',
          noRemote: 'No remote configured. Set config.remote in ~/.dsh/cordis.patch.yml first.',
          applyConfirm:
            'Pull will overwrite managed files on this machine. A snapshot is written first. Continue?',
          applied: 'Remote configuration applied. Restart DSH when convenient.',
          error: 'Request failed',
        }

    async function request(path, options) {
      var response = await fetch(path, options)
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
        data: null,
        error: null,
        result: '',
        message: '',
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

      React.useEffect(
        function () {
          load(false)
        },
        [load],
      )

      async function run(path, body, confirmText) {
        if (confirmText && !window.confirm(confirmText)) return
        setView(function (current) {
          return { ...current, busy: true, error: null }
        })
        try {
          var data = await request(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          setView(function (current) {
            return { ...current, busy: false, result: data.text || '' }
          })
          await load(true)
        } catch (error) {
          setView(function (current) {
            return { ...current, busy: false, error: error }
          })
        }
      }

      var data = view.data || {}
      var disabled = view.busy || view.loading
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
            view.loading ? '…' : copy.status,
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
              disabled: disabled,
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
                run(ROUTES.pull, { apply: false })
              },
              style: buttonStyle(false),
            },
            copy.preview,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: disabled,
              onClick: function () {
                run(ROUTES.pull, { apply: true }, copy.applyConfirm)
              },
              style: buttonStyle(false),
            },
            copy.apply,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: disabled,
              onClick: function () {
                run(ROUTES.push, { message: view.message })
              },
              style: buttonStyle(true),
            },
            copy.push,
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
