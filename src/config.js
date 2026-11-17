import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { SyncError } from './errors.js'

/** Package name used for profile detection and bundle rows. */
export const PACKAGE_NAME = 'dsh-config-git-sync'

/** Cordis row id; stable so existing patch files keep working. */
export const PLUGIN_ID = 'config-sync'

export const Config = Schema.object({
  remote: Schema.string()
    .default('')
    .description('Git remote URL of the private config repository (SSH, HTTPS or a local path).'),
  branch: Schema.string().default('main').description('Branch to read and write.'),
  profile: Schema.string()
    .default('')
    .description('Profile name. Empty auto-detects the profile that has this plugin installed.'),
  dshHome: Schema.string()
    .default('')
    .description('Harness home. Empty uses $DSH_HOME or ~/.dsh.'),
  includeLockfile: Schema.boolean()
    .default(false)
    .description('Also sync pnpm-lock.yaml. Enable when every machine uses pnpm.'),
  includeWorkspace: Schema.boolean()
    .default(false)
    .description('Also sync pnpm-workspace.yaml, including allowBuilds and release-age settings.'),
  reconcile: Schema.union([Schema.const('none'), Schema.const('install')])
    .default('none')
    .description(
      'After a pull, run the package manager in the profile (install) or leave files only (none). install executes package scripts selected by the remote manifest.',
    ),
  snapshot: Schema.boolean()
    .default(true)
    .description('Write a local pre-restore snapshot before applying remote files.'),
  snapshotKeep: Schema.number()
    .default(20)
    .description('Number of snapshots to keep per profile. 0 keeps every snapshot.'),
  secretScan: Schema.union([Schema.const('warn'), Schema.const('off')])
    .default('warn')
    .description('Warn when managed files look like they contain inline credentials.'),
  gitBin: Schema.string().default('git').description('Git executable.'),
  authorName: Schema.string().default('dsh-config-git-sync').description('Commit author name.'),
  authorEmail: Schema.string()
    .default('dsh-config-git-sync@localhost')
    .description('Commit author email.'),
})

const DEFAULTS = {
  remote: '',
  branch: 'main',
  profile: '',
  dshHome: '',
  includeLockfile: false,
  includeWorkspace: false,
  reconcile: 'none',
  snapshot: true,
  snapshotKeep: 20,
  secretScan: 'warn',
  gitBin: 'git',
  authorName: 'dsh-config-git-sync',
  authorEmail: 'dsh-config-git-sync@localhost',
}

/** Normalize a partial config without going through the Cordis schema (tests). */
export function normalizeConfig(input = {}) {
  const out = { ...DEFAULTS }
  const source = input && typeof input === 'object' ? input : {}
  for (const key of Object.keys(DEFAULTS)) {
    const value = source[key]
    if (value === undefined || value === null) continue
    out[key] = value
  }
  out.remote = String(out.remote ?? '').trim()
  out.branch = String(out.branch ?? '').trim() || 'main'
  out.profile = String(out.profile || '').trim()
  out.dshHome = String(out.dshHome || '').trim()
  out.gitBin = String(out.gitBin || 'git').trim() || 'git'
  out.authorName = String(out.authorName || '').trim() || DEFAULTS.authorName
  out.authorEmail = String(out.authorEmail || '').trim() || DEFAULTS.authorEmail
  out.reconcile = out.reconcile === 'install' ? 'install' : 'none'
  out.secretScan = out.secretScan === 'off' ? 'off' : 'warn'
  out.snapshot = out.snapshot !== false
  out.includeLockfile = out.includeLockfile === true
  out.includeWorkspace = out.includeWorkspace === true
  const keep = Number(out.snapshotKeep)
  out.snapshotKeep = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : DEFAULTS.snapshotKeep
  return out
}

export function resolveDshHome(config) {
  const configured = String(config?.dshHome || '').trim()
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return join(homedir(), configured.slice(2))
  }
  if (configured) return configured
  const fromEnv = String(process.env.DSH_HOME || '').trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

export function requireRemote(config) {
  const remote = String(config?.remote || '').trim()
  if (!remote) {
    throw new SyncError(
      'E_CONFIG',
      'no git remote configured; set config.remote in cordis.patch.yml, e.g. git@github.com:you/dsh-config.git',
    )
  }
  return remote
}

/**
 * Branch names are used in refspecs and as cache checkout targets. Reject
 * anything outside a conservative ASCII subset so a typo cannot turn into a
 * different Git operation.
 */
export function requireBranch(config) {
  const branch = String(config?.branch || '').trim() || 'main'
  const invalid =
    branch.length > 200 ||
    !/^[A-Za-z0-9]/.test(branch) ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.split('/').some((part) => part === '' || part === '.' || part === '..' || part.endsWith('.lock'))
  if (invalid) {
    throw new SyncError('E_CONFIG', `invalid branch name: ${branch}`)
  }
  return branch
}
