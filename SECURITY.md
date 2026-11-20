# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub security advisories](https://github.com/FairmeHIT/dsh-sync/security/advisories/new)
instead of opening a public issue. Include the affected version, a reproduction, and the
impact you believe is possible.

## Scope and design

This plugin moves a small, explicit set of files between a DeepSeek Harness profile and a
Git repository that the user chooses and controls:

- `profiles/<profile>/package.json`
- `profiles/<profile>/cordis.patch.yml`
- `profiles/<profile>/pnpm-workspace.yaml` (opt-in)
- `profiles/<profile>/pnpm-lock.yaml` (opt-in)
- `profiles/<profile>/manifest.json` (metadata)

It never reads `.credentials.yaml`, sessions, `storages/`, skills, memories, attachments or
workspace data. Git runs non-interactively and the plugin never asks for or stores a token.

Remote repository content is treated as untrusted input. The plugin validates every path
against the allowlist, rejects symlinks and submodules, verifies SHA-256 and size against the
manifest, reads exact blobs from Git objects rather than a filtered checkout, and verifies the
staged and committed bytes before pushing. Remote-provided text is stripped of control/ANSI
characters and bounded before it reaches model-visible output.

## Package installation runs after a pull

`reconcile` defaults to `install`: a pull that changes `package.json`, the lockfile or the plugin
list runs `pnpm install`, `corepack pnpm install` or `npm install` in the profile. Because the
remote `package.json` (and the optional `pnpm-workspace.yaml`, which can contain `allowBuilds`)
selects the packages and install scripts, only keep the default for a repository you trust, and
review the pulled diff first. Set `reconcile: none` to write files only and print the manual
install command.

The install step is gated on content, not just on the presence of a file:

- `E_INSTALL_EMPTY` / `E_INSTALL_SHRINK`: a remote manifest that removes every dependency, or at
  least half of them, skips the automatic install and reports it.
- After an install the plugin checks that every dependency declared in the pulled `package.json`
  exists in `node_modules` and reports the missing ones in the pull output.

## A pull can no longer empty a profile

The plugin never deletes `package.json` or `cordis.patch.yml`. When the remote manifest omits one
of them, the local copy is kept and reported as `kept locally`, because an incomplete remote (for
example a branch pushed from a profile that had already lost the file) is indistinguishable from
an intentional removal.

Every other managed file that the remote drops is quarantined into
`$DSH_HOME/config-sync/snapshots/<profile>/<stamp>/removed/` instead of being deleted, and every
apply writes a rollback snapshot even when `snapshot: false` is configured.

A pull that would drop the whole plugin list, or at least half of it while at least five plugins
were present, is refused with `E_DESTRUCTIVE_PULL` until it is re-run with `--force`
(`/sync-pull apply --force`, the tool's `force: true`, or the card's forced confirmation).

## Secrets in the synchronized files

`cordis.patch.yml` can legitimately contain inline credentials for third-party model
providers. The plugin warns about obvious inline keys and well-known token formats, but the
check is a heuristic, not a guarantee. Keep the Git repository private, prefer environment
variable references such as `apiKeyEnv`, and review `/sync-status` output before pushing.

Pre-restore snapshots under `$DSH_HOME/config-sync/snapshots/` contain copies of managed files,
including any inline secrets, and are written with 0600 permissions on POSIX. Remove old snapshots
if that is not acceptable on the machine.

## Line endings

The plugin verifies exact bytes. A repository where another machine committed with
`core.autocrlf=true` can rewrite line endings and invalidate the manifest; the plugin fails closed
with `E_MANIFEST` and asks you to re-commit with line-ending conversion disabled.

## Supported versions

Security fixes are provided for the current `0.2.x` line. Pre-release versions of DeepSeek
Harness are supported only within the range declared in `package.json`.
