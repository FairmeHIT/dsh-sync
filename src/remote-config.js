import { displayRemote } from './git.js'

const pendingEntries = new WeakSet()
const keys = ['remote', 'branch', 'profile']

function configError(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Only these non-secret fields may be edited through the owner-only route. */
export function validateRemoteFields(input) {
  const invalid = () => { throw configError('E_CONFIG_INPUT', 'Invalid remote, branch or profile. Use credential-free HTTPS, SSH or a trusted-server local path.') }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) invalid()
  if (keys.some((key) => typeof input[key] !== 'string')) invalid()
  if (keys.some((key) => /[\x00-\x1f\x7f]/.test(input[key]))) invalid()
  const remote = input.remote.trim(), branch = input.branch.trim() || 'main', profile = input.profile.trim()
  if (remote.length > 2048 || branch.length > 200 || profile.length > 100) invalid()
  if (remote && (/^[\-]/.test(remote) || /[?#]/.test(remote) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|3f|23|40|3a)/i.test(remote))) invalid()
  if (remote.includes('://')) {
    let url
    try { url = new URL(remote) } catch { invalid() }
    if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash || /[\s\\]/.test(remote)) invalid()
    if (url.protocol === 'https:' && url.username) invalid()
    if (url.protocol === 'ssh:' && url.username && url.username !== 'git') invalid()
  } else if (remote && !/^[A-Za-z]:[\\/]/.test(remote) && /^[^/\\]+:/.test(remote)) {
    if (!/^git@[A-Za-z0-9.-]+:(?!-)[A-Za-z0-9_./~-]+$/.test(remote) || remote.includes('::')) invalid()
  } else if (remote.includes('@')) invalid()
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('.') || branch.endsWith('/') || branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) invalid()
  if (profile && (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(profile) || profile.includes('..'))) invalid()
  return { remote, branch, profile }
}

/** Sensitive existing remotes are display-only, never supplied as form values. */
export function publicConfig(config) {
  let remoteEditable = true
  try { validateRemoteFields({ remote: String(config.remote || ''), branch: 'main', profile: '' }) } catch { remoteEditable = false }
  return {
    remote: remoteEditable ? String(config.remote || '') : '',
    remoteDisplay: remoteEditable ? displayRemote(config.remote) : '(credential-bearing or unsupported remote hidden)',
    remoteEditable,
    branch: String(config.branch || 'main'),
    profile: String(config.profile || ''),
    persistence: 'profile-patch',
  }
}

/** The editor serializes profile storage; guard duplicate requests for this entry too. */
export function createConfigEditor(ctx) {
  return {
    async save(input) {
      const fields = validateRemoteFields(input)
      const entry = ctx.fiber?.entry
      let editor
      try { editor = ctx.get?.('configEditor') } catch { /* unavailable */ }
      if (!entry || typeof editor?.edit !== 'function') throw configError('E_CONFIG_EDITOR', 'Configuration editor is unavailable.')
      if (pendingEntries.has(entry)) throw configError('E_CONFIG_BUSY', 'Configuration save is already in progress. Retry after reload.')
      pendingEntries.add(entry)
      try {
        await editor.edit(entry, (current) => ({ ...current, ...fields }))
      } catch {
        throw configError('E_CONFIG_SAVE', 'Configuration could not be saved. Check editor availability and higher-priority overrides, then retry.')
      } finally {
        pendingEntries.delete(entry)
      }
    },
  }
}
