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
      probe: '/api/config-sync/probe',
      update: '/api/config-sync/update',
      updateState: '/api/config-sync/update-state',
    }

    var zh =
      typeof navigator !== 'undefined' && /^zh/i.test(String(navigator.language || ''))

    var copy = zh
      ? {
          title: '配置同步',
          subtitle: '一键换机，多端同步 · 用私有 Git 同步插件清单与配置',
          remote: '远端',
          branch: '分支',
          profile: 'Profile',
          profileHint: '留空自动检测',
          refresh: '刷新',
          test: '测试连接',
          testBusy: '测试中…',
          testDone: '连接测试通过：远端可读写。',
          status: '状态',
          ready: '就绪',
          inSync: '已与远端一致',
          changes: '有差异',
          differences: '发现差异，建议先预览',
          statusUnavailable: '状态不可用',
          syncTitle: '同步',
          pullTitle: '从远端拉取',
          pullHint: '先预览远端改动，确认后再写入本机。',
          preview: '预览拉取',
          previewTitle: '待应用的改动',
          applyHint: '应用前会自动写入本机快照。',
          apply: '应用拉取',
          cancel: '取消',
          pushTitle: '推送到远端',
          pushHint: '把本机的 Profile 与插件清单发布到私有仓库。',
          push: '推送',
          syncBusy: '同步中…',
          pullBusy: '拉取中…',
          pushBusy: '推送中…',
          pushDone: '推送完成：远端已更新。',
          previewReady: '预览完成，尚未写入任何文件。',
          upToDate: '已是最新，没有需要同步的改动。',
          message: '提交信息（可选）',
          messageHint: '留空则自动生成',
          loading: '正在读取远端状态…',
          empty: '还没有状态。点“刷新”读取。',
          noRemote: '还没有配置远端。请在“更多”里填写仓库地址并保存。',
          advanced: '连接设置',
          output: '状态详情',
          retryConfig: '重试读取配置',
          hiddenRemote: '现有远端已隐藏；必须填写非空替换地址才能保存，不能仅修改分支或 Profile。',
          save: '保存配置', saving: '保存并核对中…', saved: '配置已保存并核对生效。',
          saveError: '无法确认配置已生效。请检查高优先级覆盖或稍后重试。',
          configWarning: '配置保存在 profile patch 中；本机这一条 config-sync 行不会被 Pull 覆盖。仅填写不含凭据的 HTTPS / SSH 地址，使用 Git 凭据管理器或 SSH；本地路径指服务器上当前信任用户可访问的路径。',
          applied: '已应用远端配置。建议重启 DSH。',
          installNext: '已应用远端配置。请先运行“{command}”，然后重启 DSH。',
          requestTimeout: '请求超时，请稍后重试。',
          busyElsewhere: '另一台同步正在进行中（可能来自本机或其他窗口），请稍后再试。',
          error: '操作失败',
          version: '插件',
          checkUpdate: '检查更新',
          checkingUpdate: '检查中…',
          updateTo: '更新到 {version}',
          updating: '正在更新…',
          updateHint: '更新会重装插件，卡片短暂中断，完成后刷新页面即可。',
          updateLocal: '本机路径安装，卡片内无法更新。',
          updateOther: '非 GitHub 安装，卡片内无法更新。',
          updateFailed: '更新失败',
          updateTimeout: '更新没有按时完成，请刷新页面查看版本。',
          updated: '已更新到 {version}。刷新页面加载新界面。',
          reload: '刷新页面',
          pull: '拉取',
          more: '更多',
          confirm: '确认',
          noRemoteShort: '未配置远端',
          pullConfirmTitle: '确认拉取？',
          pushConfirmTitle: '确认推送？',
          pullConfirmHint: '以下改动将写入本机；写入前会自动快照，可随时恢复。',
          pushConfirmHint: '本机 Profile 将写入远端分支；其他机器下次拉取时会收到这些文件。',
          adoptNote: '会把远端目录 {channel} 映射为本机 Profile {profile}。',
        }
      : {
          title: 'Config sync',
          subtitle: 'One-click migration, multi-device sync · private Git for your plugin manifest and config',
          remote: 'Remote',
          branch: 'Branch',
          profile: 'Profile',
          profileHint: 'Leave blank to auto-detect',
          refresh: 'Refresh',
          test: 'Test connection',
          testBusy: 'Testing…',
          testDone: 'Connection test passed: the remote is readable and writable.',
          status: 'Status',
          ready: 'Ready',
          inSync: 'In sync with remote',
          changes: 'Changes',
          differences: 'Differences found — preview before pulling',
          statusUnavailable: 'Status unavailable',
          syncTitle: 'Sync',
          pullTitle: 'Pull from remote',
          pullHint: 'Preview the remote changes first; nothing is written until you apply.',
          preview: 'Preview pull',
          previewTitle: 'Changes to apply',
          applyHint: 'A snapshot is written before files are overwritten.',
          apply: 'Apply pull',
          cancel: 'Cancel',
          pushTitle: 'Push to remote',
          pushHint: "Publish this machine's profile and plugin manifest to the private repository.",
          push: 'Push',
          syncBusy: 'Syncing…',
          pullBusy: 'Pulling…',
          pushBusy: 'Pushing…',
          pushDone: 'Push complete: the remote is updated.',
          previewReady: 'Preview ready. Nothing has been written yet.',
          upToDate: 'Already up to date; nothing to sync.',
          message: 'Commit message (optional)',
          messageHint: 'Leave blank to auto-generate',
          loading: 'Reading the remote status…',
          empty: 'No status yet. Choose Refresh.',
          noRemote: 'No remote configured. Open More, enter a repository, and save.',
          advanced: 'Connection settings',
          output: 'Status details',
          retryConfig: 'Retry loading configuration',
          hiddenRemote: 'The existing remote is hidden. Enter a nonempty replacement before saving; branch-only edits cannot preserve a hidden remote.',
          save: 'Save configuration', saving: 'Saving and verifying…', saved: 'Configuration saved and verified.',
          saveError: 'Could not verify effective configuration. Check higher-priority overrides or retry after reload.',
          configWarning: "Saved in the profile patch; Pull keeps this machine's config-sync row. Use credential-free HTTPS / SSH with Git credential manager or SSH. Local paths refer to the server and its currently trusted user.",
          applied: 'Remote configuration applied. Restart DSH when convenient.',
          installNext: 'Remote configuration applied. Run "{command}", then restart DSH.',
          requestTimeout: 'The request timed out. Please retry.',
          busyElsewhere: 'Another sync is already running (possibly from this machine or another window). Retry shortly.',
          error: 'Request failed',
          version: 'Plugin',
          checkUpdate: 'Check for updates',
          checkingUpdate: 'Checking…',
          updateTo: 'Update to {version}',
          updating: 'Updating…',
          updateHint: 'Updating reinstalls the plugin; the card drops out briefly. Reload the page when it finishes.',
          updateLocal: 'Installed from a local path, so the card cannot update it.',
          updateOther: 'Not a GitHub install, so the card cannot update it.',
          updateFailed: 'Update failed',
          updateTimeout: 'The update did not finish in time. Reload the page to see the version.',
          updated: 'Updated to {version}. Reload the page to load the new UI.',
          reload: 'Reload page',
          pull: 'Pull',
          more: 'More',
          confirm: 'Confirm',
          noRemoteShort: 'No remote configured',
          pullConfirmTitle: 'Pull from remote?',
          pushConfirmTitle: 'Push to remote?',
          pullConfirmHint: 'These changes will be written to this machine. A snapshot is taken first and can be restored.',
          pushConfirmHint: "This machine's profile will be written to the remote branch; other machines receive it on their next pull.",
          adoptNote: "Maps remote directory {channel} to this machine's profile {profile}.",
        }

    var CSS = `
.dcfg-root { display:flex; flex-direction:column; gap:12px; padding:2px 0 16px; color:var(--dsw-alias-label-primary, inherit); font-size:13px; line-height:1.55; }
.dcfg-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.dcfg-headtext { min-width:0; }
.dcfg-title { margin:0; font-size:15px; font-weight:600; letter-spacing:.01em; }
.dcfg-subtitle { margin:2px 0 0; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:12.5px; }
.dcfg-chip { flex:0 0 auto; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius:999px; padding:2px 9px; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:12px; white-space:nowrap; }
.dcfg-card { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius:12px; background:var(--dsw-alias-bg-layer-1, transparent); padding:14px 16px; display:flex; flex-direction:column; gap:10px; }
.dcfg-cardtitle { font-size:13.5px; font-weight:600; }
.dcfg-verdict { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; }
.dcfg-dot { width:8px; height:8px; border-radius:50%; background:currentColor; flex:0 0 auto; }
.dcfg-verdict-ok { color:var(--dsw-alias-state-success-primary, #2f9e63); }
.dcfg-verdict-warn { color:var(--dsw-alias-state-warn-primary, #b7791f); }
.dcfg-verdict-muted { color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); }
.dcfg-facts { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr); gap:6px 16px; }
.dcfg-fact { min-width:0; }
.dcfg-key { color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:11.5px; }
.dcfg-val { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; }
.dcfg-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dcfg-btn { appearance:none; font:inherit; font-size:12.5px; line-height:1.4; padding:6px 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); color:inherit; cursor:pointer; }
.dcfg-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary, currentColor); }
.dcfg-btn:disabled { opacity:.55; cursor:default; }
.dcfg-btn-primary { background:var(--dsw-alias-brand-primary, #3b82f6); border-color:transparent; color:#fff; }
.dcfg-btn-primary:hover:not(:disabled) { opacity:.92; }
.dcfg-syncgrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); align-items:start; gap:12px; }
.dcfg-section { display:flex; flex-direction:column; gap:8px; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius:10px; background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.03)); padding:12px; }
.dcfg-sectiontitle { font-size:13px; font-weight:600; }
.dcfg-hint { color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:12.5px; }
.dcfg-warn { color:var(--dsw-alias-state-warn-primary, #b7791f); }
.dcfg-field { display:grid; gap:4px; }
.dcfg-field > span { color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:12px; }
.dcfg-input { width:100%; box-sizing:border-box; font:inherit; font-size:12.5px; padding:6px 10px; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); border-radius:8px; background:var(--dsw-alias-bg-base, transparent); color:inherit; }
.dcfg-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary, currentColor); }
.dcfg-input:disabled { opacity:.6; }
.dcfg-notice { border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius:9px; padding:8px 10px; font-size:12.5px; line-height:1.5; }
.dcfg-notice-ok { border-color:var(--dsw-alias-state-success-primary, #2f9e63); }
.dcfg-notice-error { border-color:var(--dsw-alias-state-error-primary, #d14343); color:var(--dsw-alias-state-error-primary, #d14343); }
.dcfg-preview { border:1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
.dcfg-preview-head { font-size:12.5px; font-weight:600; }
.dcfg-preview-text { max-height:200px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; line-height:1.55; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); }
.dcfg-details { border-top:1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.22)); padding-top:8px; }
.dcfg-details > summary { cursor:pointer; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:12.5px; }
.dcfg-details[open] > summary { margin-bottom:10px; }
.dcfg-advbody { display:flex; flex-direction:column; gap:10px; }
.dcfg-pre { margin:0; max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; line-height:1.55; padding:10px 12px; border-radius:8px; background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.dcfg-progress { width:100%; height:6px; accent-color:var(--dsw-alias-brand-primary, currentColor); }
.dcfg-version { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; border-top:1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.22)); padding-top:10px; }
.dcfg-versiontext { min-width:0; display:flex; flex-direction:column; gap:2px; }
.dcfg-versionline { font-size:12.5px; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); }
.dcfg-versionline strong { color:inherit; font-weight:600; }
.dcfg-version-note { font-size:12px; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); }
.dcfg-version-note-warn { color:var(--dsw-alias-state-warn-primary, #b7791f); }
.dcfg-meta { margin:2px 0 0; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcfg-chip-ok { color:var(--dsw-alias-state-success-primary, #2f9e63); border-color:var(--dsw-alias-state-success-primary, #2f9e63); }
.dcfg-chip-warn { color:var(--dsw-alias-state-warn-primary, #b7791f); border-color:var(--dsw-alias-state-warn-primary, #b7791f); }
.dcfg-chip-muted { color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); }
.dcfg-more { border-top:1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.dcfg-more > summary { cursor:pointer; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:12.5px; padding:6px 0; }
.dcfg-more[open] > summary { margin-bottom:8px; }
.dcfg-morebody { display:flex; flex-direction:column; gap:10px; padding-bottom:6px; }
.dcfg-moreline { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dcfg-raw > summary { cursor:pointer; color:var(--dsw-alias-label-secondary, rgba(127,127,127,.85)); font-size:12px; }
.dcfg-raw > pre { margin:6px 0 0; max-height:240px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; line-height:1.55; padding:10px 12px; border-radius:8px; background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.dcfg-modal { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(0,0,0,.42); }
.dcfg-modal-card { width:min(560px, 100%); max-height:80vh; overflow:auto; display:flex; flex-direction:column; gap:10px; padding:16px; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius:12px; background:var(--dsw-alias-bg-layer-1, #fff); box-shadow:0 18px 48px rgba(0,0,0,.28); }
.dcfg-modal-title { margin:0; font-size:14px; font-weight:600; }
.dcfg-modal-actions { display:flex; justify-content:flex-end; gap:8px; }
.dcfg-adopt { color:var(--dsw-alias-state-warn-primary, #b7791f); font-size:12.5px; }
@media (max-width:560px) {
  .dcfg-head { flex-direction:column; }
  .dcfg-facts { grid-template-columns:1fr; }
}
`

    var stylesInjected = false
    /** Add this card's stylesheet once per document. Tests run without a DOM. */
    function ensureStyles() {
      if (stylesInjected || typeof document === 'undefined') return
      stylesInjected = true
      var style = document.createElement('style')
      style.setAttribute('data-dsh-config-sync', '')
      style.textContent = CSS
      document.head.append(style)
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

    /**
     * The dry-run report is written for the CLI. The card already shows the
     * remote/branch/profile facts and offers Apply itself, so drop the repeated
     * identity block and the "run /sync-pull apply" instruction from the
     * preview panel. The full text stays available under Status details.
     */
    function previewBody(text) {
      var lines = String(text || '').split('\n')
      while (lines.length > 0 && /^(Config sync pull(?: \(dry run\))?|remote:|branch:|profile:)/.test(lines[0].trim())) lines.shift()
      return lines
        .filter(function (line) { return !/^Nothing written\. Run \/sync-pull apply/.test(line.trim()) })
        .join('\n')
        .replace(/^\n+/, '')
        .trim()
    }

    function Card() {
      ensureStyles()
      var state = React.useState({
        loading: true,
        busy: false,
        busyAction: '',
        data: null,
        error: null,
        notice: '',
        result: '',
        message: '',
        preview: null,
        draft: { remote: '', branch: 'main', profile: '' },
        configLoading: true,
        configReady: false,
        configOpen: true,
        remoteHidden: false,
        saving: false,
        configError: null,
        dialog: null,
        update: null,
        updateStarted: false,
      })
      var view = state[0]
      var setView = state[1]

      var load = React.useCallback(async function (preserveResult, restoreBusy) {
        setView(function (current) {
          return {
            ...current,
            loading: true,
            error: null,
            result: preserveResult ? current.result : '',
            notice: preserveResult ? current.notice : '',
            preview: preserveResult ? current.preview : null,
          }
        })
        try {
          var data = await request(ROUTES.status)
          setView(function (current) {
            // Remount recovery: the host reports an in-flight sync; show the
            // busy state instead of an idle card over a running operation.
            if (data.busy === true) {
              return { ...current, loading: false, busy: true, busyAction: data.activity && data.activity.action ? data.activity.action : 'sync', data: { ...current.data, ...data }, error: null }
            }
            if (restoreBusy !== false && data.activity && data.activity.finishedAt && data.activity.text) {
              return { ...current, loading: false, busy: false, busyAction: '', data: data, error: null, result: current.result || data.activity.text }
            }
            return { ...current, loading: false, busy: false, busyAction: '', data: data, error: null }
          })
        } catch (error) {
          setView(function (current) {
            return { ...current, loading: false, busy: false, error: error }
          })
        }
      }, [])

      async function loadConfig() {
        setView(function (current) { return { ...current, configLoading: true, configReady: false, configError: null } })
        try {
          var data = await configRequest()
          setView(function (current) {
            return {
              ...current,
              configLoading: false,
              configReady: true,
              // First run has no remote yet: open the settings a reader needs
              // instead of leaving the fix one click away in a closed section.
              configOpen: current.configOpen || data.remoteEditable === false || !String(data.remote || '').trim(),
              remoteHidden: data.remoteEditable === false,
              draft: { remote: data.remoteEditable === false ? '' : data.remote, branch: data.branch, profile: data.profile },
            }
          })
        } catch {
          setView(function (current) { return { ...current, configLoading: false, configReady: false, configOpen: true, configError: copy.saveError } })
        }
      }

      React.useEffect(
        function () {
          load(false)
          loadConfig()
        },
        [load],
      )

      // More starts expanded, so the version row is visible immediately. Run
      // the silent check once on mount instead of waiting for a toggle.
      React.useEffect(
        function () {
          if (!view.configOpen || view.updateStarted) return
          setView(function (current) { return { ...current, updateStarted: true } })
          checkUpdate(true)
        },
        [],
      )

      async function run(path, body, action) {
        setView(function (current) {
          return { ...current, busy: true, busyAction: action, error: null, notice: '', result: '', preview: action === 'preview' ? null : current.preview }
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
          // A skipped dependency install is not a failure, but the plugins are
          // missing until the command runs, so the notice names it.
          var installCommand = data.needsInstall === true
            ? 'dsh plugin --profile ' + ((data.profile || '').trim() || 'desktop') + ' install'
            : ''
          var noChanges = data.upToDate === true || /^Already up to date(?:; nothing to commit|\.)\.?$/im.test(text)
          var notice = noChanges
            ? copy.upToDate
            : action === 'probe'
              ? copy.testDone
              : action === 'push'
                ? copy.pushDone
                : action === 'apply'
                  ? (installCommand ? copy.installNext.replace('{command}', installCommand) : copy.applied)
                  : copy.previewReady
          setView(function (current) {
            return {
              ...current,
              busy: false,
              busyAction: '',
              result: text,
              notice: notice,
              // A preview exposes Apply; a write discards the stale preview.
              preview: action === 'preview'
                ? (noChanges ? null : { text: previewBody(text) || text })
                : action === 'push' || action === 'apply'
                  ? null
                  : current.preview,
            }
          })
          await load(true, false)
        } catch (error) {
          setView(function (current) {
            // A held lock means another sync is running elsewhere (or in
            // another window): show the dedicated busy message instead of a
            // generic failure, and keep the card usable for a retry.
            if (error && error.code === 'E_BUSY') {
              return { ...current, busy: false, busyAction: '', notice: copy.busyElsewhere, error: null }
            }
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
          setView(function (current) { return { ...current, saving: false, remoteHidden: false, preview: null, notice: copy.saved, data: { ...current.data, ...verified } } })
          await load(true)
        } catch (error) {
          // Surface the server's own rejection code/message (E_CONFIG_INPUT,
          // E_CONFIG_BUSY, …) instead of a generic string that hides the cause.
          setView(function (current) {
            return { ...current, saving: false, configError: (error && (error.code || error.message)) ? (error.code ? error.code + ' — ' : '') + error.message : copy.saveError, notice: '' }
          })
        }
      }

      // The card runs no installer of its own: the DSH plugin manager unloads
      // this version, installs the published commit and rolls back on failure.
      // The install kills the request that started it, so its outcome is
      // followed through the state file instead of the install response.
      async function checkUpdate(silent) {
        // A silent mount check shows nothing until it answers, so the row never
        // flashes "Checking…" over a slow GitHub read.
        if (!silent) {
          setView(function (current) {
            return { ...current, update: { ...(current.update || {}), phase: 'checking', message: '' } }
          })
        }
        try {
          var data = await request(ROUTES.update, { timeoutMs: 30000 })
          setView(function (current) {
            return {
              ...current,
              update: {
                phase: data.supported !== true ? 'unsupported' : data.available === true ? 'available' : 'current',
                current: data.current || '',
                latest: data.latest || '',
                reason: data.reason || '',
                message: data.error || data.detail || '',
              },
            }
          })
        } catch (error) {
          setView(function (current) {
            // The mount-time check stays silent: a GitHub outage must not greet
            // the reader with an error on an otherwise healthy card.
            if (silent) return { ...current, update: { phase: 'unavailable', current: '', latest: '', reason: '', message: '' } }
            return {
              ...current,
              update: { ...(current.update || {}), phase: 'check-failed', message: (error && error.message) || '' },
            }
          })
        }
      }

      function pollUpdate(tries) {
        var attempt = (tries || 0) + 1
        function next() {
          if (attempt >= 80) {
            setView(function (current) {
              return { ...current, update: { ...(current.update || {}), phase: 'check-failed', message: copy.updateTimeout } }
            })
            return
          }
          setTimeout(function () { pollUpdate(attempt) }, 1500)
        }
        request(ROUTES.updateState, { timeoutMs: 15000 })
          .then(function (data) {
            var state = data.update
            if (!state || state.status === 'running') {
              next()
              return
            }
            setView(function (current) {
              if (state.status === 'done') {
                return {
                  ...current,
                  update: { phase: 'done', current: state.to, latest: state.to, reason: '', message: '' },
                  notice: copy.updated.replace('{version}', state.to),
                }
              }
              return {
                ...current,
                update: {
                  ...(current.update || {}),
                  phase: 'failed',
                  current: state.from || (current.update && current.update.current) || '',
                  latest: state.to || '',
                  message: state.message || copy.updateFailed,
                },
              }
            })
          })
          .catch(function () {
            // The plugin is unloading: its routes fail for a moment, which is
            // expected while the replacement starts.
            next()
          })
      }

      async function startUpdate() {
        setView(function (current) {
          return { ...current, update: { ...(current.update || {}), phase: 'updating', message: '' } }
        })
        try {
          await request(ROUTES.update, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            // The host answers before it installs, so this stays short.
            timeoutMs: 120000,
          })
          pollUpdate(0)
        } catch (error) {
          setView(function (current) {
            return {
              ...current,
              update: {
                ...(current.update || {}),
                phase: 'failed',
                message: error && error.code === 'E_BUSY'
                  ? copy.busyElsewhere
                  : (error && error.message) || copy.updateFailed,
              },
            }
          })
        }
      }

      function busyLabel(action) {
        if (action === 'push') return copy.pushBusy
        if (action === 'probe') return copy.testBusy
        if (action === 'preview' || action === 'apply') return copy.pullBusy
        return copy.syncBusy
      }

      function fact(label, value) {
        return h('div', { className: 'dcfg-fact' },
          h('div', { className: 'dcfg-key' }, label),
          h('div', { className: 'dcfg-val', title: value || '' }, value || '—'),
        )
      }

      /**
       * The plugin's own version, and the one action that fits its state:
       * check, update, or reload once the manager has installed a new copy.
       */
      function versionRow() {
        var update = view.update
        if (!update) return null
        var phase = update.phase
        var current = update.current || ''
        var latest = update.latest || ''
        // Nothing is known about the version until a check answers, so an
        // offline mount shows the action alone instead of a made-up version.
        // The arrow appears only while an update is on the table: a pinned copy
        // can sit ahead of the branch it was pinned from, and "0.7.5 → 0.7.3"
        // would read as an instruction to downgrade.
        var offersUpdate = phase === 'available' || phase === 'updating' || phase === 'failed'
        var line = current ? copy.version + ' ' + current : ''
        if (line && offersUpdate && latest && latest !== current) {
          line = copy.version + ' ' + current + ' → ' + latest
        }
        var note = ''
        var warn = false
        if (phase === 'unsupported') {
          note = update.reason === 'local-install'
            ? copy.updateLocal
            : update.reason === 'not-github'
              ? copy.updateOther
              : update.message || copy.updateOther
          warn = true
        } else if (phase === 'check-failed' || phase === 'failed') {
          note = update.message || copy.updateFailed
          warn = true
        } else if (phase === 'available' || phase === 'updating') {
          note = copy.updateHint
        }
        var label = ''
        if (phase === 'done') label = copy.reload
        else if (phase === 'available' || phase === 'failed') label = copy.updateTo.replace('{version}', latest || '')
        else if (phase === 'updating') label = copy.updating
        else if (phase === 'checking') label = copy.checkingUpdate
        else if (phase !== 'unsupported') label = copy.checkUpdate
        var updateDisabled = view.busy || view.saving || phase === 'checking' || phase === 'updating'
        return h('div', { className: 'dcfg-version' },
          h('div', { className: 'dcfg-versiontext' },
            line ? h('div', { className: 'dcfg-versionline' }, line) : null,
            note ? h('div', { className: 'dcfg-version-note' + (warn ? ' dcfg-version-note-warn' : '') }, note) : null,
          ),
          label
            ? h('button', {
                type: 'button',
                className: 'dcfg-btn' + (phase === 'available' || phase === 'done' ? ' dcfg-btn-primary' : ''),
                disabled: updateDisabled,
                onClick: function () {
                  if (phase === 'done') {
                    if (typeof window !== 'undefined' && window.location) window.location.reload()
                    return
                  }
                  if (phase === 'available' || phase === 'failed') {
                    startUpdate()
                    return
                  }
                  checkUpdate(false)
                },
              }, label)
            : null,
        )
      }

      function configField(key) {
        var label = copy[key]
        return h('label', { key: key, className: 'dcfg-field' },
          h('span', null, label),
          h('input', {
            type: 'text',
            'aria-label': label,
            className: 'dcfg-input',
            value: view.draft[key],
            maxLength: key === 'remote' ? 2048 : key === 'branch' ? 200 : 100,
            placeholder: key === 'profile' ? copy.profileHint : undefined,
            autoComplete: 'off',
            spellCheck: false,
            disabled: disabled || view.configLoading || !view.configReady,
            onChange: function (event) {
              var value = event.target.value
              setView(function (current) { return { ...current, draft: { ...current.draft, [key]: value } } })
            },
          }),
        )
      }

      // Pull is two steps by design: this click only compares. The dialog's
      // confirm is the only request that writes, and Cancel sends nothing.
      async function openPull() {
        if (view.busy || view.loading) return
        setView(function (current) {
          return { ...current, busy: true, busyAction: 'preview', error: null, notice: '', result: '' }
        })
        try {
          var data = await request(ROUTES.pull, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apply: false }),
            timeoutMs: 600000,
          })
          var text = data.text || ''
          var noChanges = data.upToDate === true || /^Already up to date(?:; nothing to commit|\.)\.?$/im.test(text)
          if (noChanges) {
            setView(function (current) { return { ...current, busy: false, busyAction: '', notice: copy.upToDate } })
            await load(true, false)
            return
          }
          setView(function (current) {
            return {
              ...current,
              busy: false,
              busyAction: '',
              dialog: {
                kind: 'pull',
                text: previewBody(text) || text,
                channel: String(data.channel || ''),
                profile: String(data.profile || (current.data && current.data.profile) || ''),
                adopted: data.adopted === true,
              },
            }
          })
        } catch (error) {
          setView(function (current) {
            if (error && error.code === 'E_BUSY') {
              return { ...current, busy: false, busyAction: '', notice: copy.busyElsewhere, error: null }
            }
            return { ...current, busy: false, busyAction: '', error: error, notice: '' }
          })
        }
      }

      // Push has nothing to fetch, so its confirmation opens at once; the
      // dialog's confirm is the only request that touches the remote.
      function openPush() {
        if (view.busy || view.loading) return
        setView(function (current) {
          return {
            ...current,
            error: null,
            notice: '',
            dialog: {
              kind: 'push',
              text: '',
              channel: '',
              profile: String((current.data && current.data.profile) || ''),
              adopted: false,
            },
          }
        })
      }

      function closeDialog() {
        setView(function (current) { return { ...current, dialog: null } })
      }

      async function confirmDialog() {
        var dialog = view.dialog
        if (!dialog || view.busy) return
        var pull = dialog.kind === 'pull'
        setView(function (current) {
          return { ...current, busy: true, busyAction: pull ? 'apply' : 'push', error: null, notice: '', result: '' }
        })
        try {
          var data = await request(pull ? ROUTES.pull : ROUTES.push, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(pull ? { apply: true } : { message: view.message }),
            timeoutMs: 600000,
          })
          var text = data.text || ''
          var installCommand = data.needsInstall === true
            ? 'dsh plugin --profile ' + (String(data.profile || (view.data && view.data.profile) || '').trim() || 'desktop') + ' install'
            : ''
          var notice = pull
            ? (installCommand ? copy.installNext.replace('{command}', installCommand) : copy.applied)
            : copy.pushDone
          setView(function (current) {
            return { ...current, busy: false, busyAction: '', result: text, notice: notice, dialog: null, message: '', error: null }
          })
          await load(true, false)
        } catch (error) {
          setView(function (current) {
            if (error && error.code === 'E_BUSY') {
              return { ...current, busy: false, busyAction: '', notice: copy.busyElsewhere, error: null }
            }
            return { ...current, busy: false, busyAction: '', error: error, notice: '' }
          })
        }
      }

      var data = view.data || {}
      var updating = !!(view.update && view.update.phase === 'updating')
      var disabled = !!(view.busy || view.loading || view.saving || updating)
      var refreshDisabled = !!(view.busy || view.saving)
      var statusText = view.result || data.text || ''
      var error = view.error
      var hint = error && error.code === 'E_CONFIG' ? copy.noRemote : ''
      var profile = String(data.profile || view.draft.profile || '')
      var channel = String(data.channel || '')
      var remote = String(data.remote || view.draft.remote || '')
      var branch = String(data.branch || view.draft.branch || 'main')
      var meta = remote || copy.noRemoteShort
      meta += ' · ' + branch
      if (profile) meta += ' · ' + copy.profile + ' ' + profile
      if (channel && channel !== profile) meta += ' → ' + channel
      var chipKind = view.busy || view.loading
        ? 'muted'
        : error && !data.text
          ? 'warn'
          : data.upToDate === true
            ? 'ok'
            : data.upToDate === false
              ? 'warn'
              : 'muted'
      var chipText = view.busy
        ? busyLabel(view.busyAction)
        : view.loading
          ? '…'
          : data.upToDate === true
            ? copy.inSync
            : data.upToDate === false
              ? copy.changes
              : copy.status

      function dialogView(box) {
        var pull = box.kind === 'pull'
        var title = pull ? copy.pullConfirmTitle : copy.pushConfirmTitle
        return h(
          'div',
          {
            className: 'dcfg-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            onClick: function (event) {
              if (event.target === event.currentTarget) closeDialog()
            },
          },
          h(
            'div',
            { className: 'dcfg-modal-card' },
            h('h3', { className: 'dcfg-modal-title' }, title),
            h('p', { className: 'dcfg-hint' }, pull ? copy.pullConfirmHint : copy.pushConfirmHint),
            pull ? h('pre', { className: 'dcfg-preview-text' }, box.text) : null,
            pull && box.channel && box.channel !== box.profile
              ? h('p', { className: 'dcfg-adopt' }, copy.adoptNote.replace('{channel}', box.channel).replace('{profile}', box.profile))
              : null,
            !pull
              ? h(
                  'label',
                  { className: 'dcfg-field' },
                  h('span', null, copy.message),
                  h('input', {
                    type: 'text',
                    className: 'dcfg-input',
                    'aria-label': copy.message,
                    maxLength: 500,
                    placeholder: copy.messageHint,
                    value: view.message,
                    autoComplete: 'off',
                    spellCheck: false,
                    disabled: view.busy,
                    onChange: function (event) {
                      var value = event.target.value
                      setView(function (current) { return { ...current, message: value } })
                    },
                  }),
                )
              : null,
            h(
              'div',
              { className: 'dcfg-modal-actions' },
              h('button', { type: 'button', className: 'dcfg-btn', disabled: view.busy, onClick: closeDialog }, copy.cancel),
              h(
                'button',
                { type: 'button', className: 'dcfg-btn dcfg-btn-primary', disabled: view.busy, onClick: confirmDialog },
                view.busy ? (pull ? copy.pullBusy : copy.pushBusy) : copy.confirm,
              ),
            ),
          ),
        )
      }

      var dialog = view.dialog
      return h(
        'div',
        { className: 'dcfg-root' },

        h(
          'div',
          { className: 'dcfg-head' },
          h(
            'div',
            { className: 'dcfg-headtext' },
            h('h2', { className: 'dcfg-title' }, copy.title),
            h('div', { className: 'dcfg-meta', title: copy.subtitle }, meta),
          ),
          h('span', { className: 'dcfg-chip dcfg-chip-' + chipKind }, chipText),
        ),

        view.notice ? h('div', { role: 'status', className: 'dcfg-notice dcfg-notice-ok' }, view.notice) : null,
        error
          ? h(
              'div',
              { role: 'alert', className: 'dcfg-notice dcfg-notice-error' },
              h('strong', null, copy.error + ': '),
              (error && error.message) || String(error),
            )
          : null,

        h(
          'div',
          { className: 'dcfg-actions' },
          h(
            'button',
            { type: 'button', className: 'dcfg-btn dcfg-btn-primary', disabled: disabled, onClick: openPull },
            view.busy && view.busyAction === 'preview' ? copy.pullBusy : copy.pull,
          ),
          h('button', { type: 'button', className: 'dcfg-btn dcfg-btn-primary', disabled: disabled, onClick: openPush }, copy.push),
        ),

        view.busy
          ? h('div', { className: 'dcfg-progress', role: 'progressbar', 'aria-label': busyLabel(view.busyAction) }, busyLabel(view.busyAction))
          : null,

        h(
          'details',
          {
            className: 'dcfg-more',
            open: view.configOpen,
            onToggle: function (event) {
              var open = !!(event.target && event.target.open)
              setView(function (current) { return { ...current, configOpen: open } })
              if (open && !view.updateStarted) {
                setView(function (current) { return { ...current, updateStarted: true } })
                checkUpdate(true)
              }
            },
          },
          h('summary', { className: 'dcfg-more-summary' }, copy.more),
          h(
            'div',
            { className: 'dcfg-morebody' },
            hint ? h('p', { className: 'dcfg-hint' }, hint) : null,
            h('p', { className: 'dcfg-hint' }, copy.configWarning),
            configField('remote'),
            configField('branch'),
            configField('profile'),
            view.remoteHidden ? h('p', { className: 'dcfg-warn' }, copy.hiddenRemote) : null,
            h(
              'div',
              { className: 'dcfg-moreline' },
              !view.configReady
                ? h('button', { type: 'button', className: 'dcfg-btn', disabled: view.saving, onClick: loadConfig }, copy.retryConfig)
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'dcfg-btn dcfg-btn-primary',
                  disabled: view.saving || view.configLoading || !view.configReady || disabled || (view.remoteHidden && !String(view.draft.remote || '').trim()),
                  onClick: saveConfig,
                },
                view.saving ? copy.saving : copy.save,
              ),
              h('button', { type: 'button', className: 'dcfg-btn', disabled: refreshDisabled, onClick: function () { load(false, false) } }, copy.refresh),
              h('button', { type: 'button', className: 'dcfg-btn', disabled: view.busy || view.saving, onClick: function () { run(ROUTES.probe, {}, 'probe') } }, copy.test),
            ),
            view.configError ? h('div', { role: 'alert', className: 'dcfg-notice dcfg-notice-error' }, view.configError) : null,
            versionRow(),
            h(
              'details',
              { className: 'dcfg-raw' },
              h('summary', null, copy.output),
              h('pre', null, statusText || (view.loading ? copy.loading : copy.empty)),
            ),
          ),
        ),

        dialog ? dialogView(dialog) : null,
      )
    }

    function SettingsPage() {
      return h('div', { style: { width: '100%', maxWidth: '780px' } }, h(Card))
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
