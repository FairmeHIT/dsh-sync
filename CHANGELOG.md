# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-11-18

### Fixed

- **Connection test failed on a remote that already holds synced files**
  (0.7.0 regression, reported live on a real profile): the probe committed a
  marker-only file set while the shared work tree already contains the
  checked-out synced files, so the staged-set verification failed with
  `E_GIT staged file set mismatch; unexpected: profiles/.../package.json,
  cordis.patch.yml, manifest.json`. The probe now commits the marker together
  with the existing synced content, byte-exact, and the cleanup commit
  removes only the marker — synced files keep their exact bytes and the
  pre-probe tip remains an ancestor of the post-probe tip. A new e2e test
  seeds a remote like a real sync before probing.

## [0.7.0] - 2026-11-18

### Added

- **Connection test button.** The card's **Test connection** writes and then removes a
  `.config-sync-probe` marker file on the remote, proving read and write access end-to-end
  without touching synced content (probe-file pattern from dsh-plugin-account-sync). The probe
  runs through the same git work tree and credentials a real sync uses, serialized by the same
  lock.
- **HTTP 409 busy semantics.** Starting a second sync while one runs now answers
  `{ ok: false, code: 'E_BUSY', busy: true }` with HTTP 409, and the card shows a dedicated
  "another sync is running" notice instead of a generic error.
- **Remount state recovery.** `GET /api/config-sync/status` now reports whether a sync is in
  flight (`busy`) plus the last recorded operation (`activity`), persisted in
  `config-sync/activity.json`. A card mounted while a sync runs shows the busy state, and a
  card mounted after a completed sync restores the last outcome, instead of both appearing idle
  (syncup's `cached=1` equivalent).

## [0.6.2] - 2026-11-18

### Changed

- **Dependency install now prefers the pnpm bundled with DSH.** `reconcile: install` first runs the
  node+pnpm runtime shipped with DSH (`dsh-primary-runtime`, the exact pnpm `dsh plugin install`
  itself uses, located via `DSH_PACK_HOME` or the DSH home), so an install after pull no longer
  depends on pnpm/corepack/npm being on the system PATH. The previous chain
  (`pnpm`, `corepack pnpm`, `npm install`) remains as the fallback when no bundled runtime is found.

## [0.6.1] - 2026-11-18

### Changed

- **`reconcile` now defaults to `install`.** A pull that changes `package.json`, a lockfile or the
  plugin list runs the package manager in the profile directory (`pnpm install`, then
  `corepack pnpm install`, then `npm install --no-audit --no-fund`), so synced plugins work on a
  new machine after a restart instead of failing with `cannot resolve profile bundle`. For a
  repository you do not trust, set `reconcile: none` to keep the old write-files-only behavior; the
  report then names `dsh plugin --profile <profile> install` as the next step. An install failure
  stops and reports the output instead of falling through to another package manager.

## [0.6.0] - 2026-11-18

### Fixed

- **Pull no longer wipes the machine's own sync settings.** The `- id: config-sync` row in
  `profiles/<profile>/cordis.patch.yml` is machine-local: it is stripped from the synced copy before
  a push, so it never reaches the repository, and it is merged back into the remote copy when a pull
  applies. Saving the repository in the plugin card therefore survives later pulls and no longer
  drops the machine back to `E_CONFIG`. A row that an older version already committed is stripped on
  the read side too, so it is neither reported as a difference nor written back.
- **A pull that skips the dependency install now names the next step.** With the default
  `reconcile: none`, a pull that changes `package.json`, a lockfile or the plugin list printed
  nothing about the missing packages. The report now includes
  `packages: manifest changed but dependencies were not installed (reconcile: none)` and
  `next: dsh plugin --profile <profile> install`, and the card shows the same command after Apply.

### Added

- `pullReport(config, { apply })` returns `{ text, needsInstall, connectionPreserved }` for callers
  that need the machine-readable outcome; `pull()` keeps returning the text.
- The pull HTTP route exposes a structured `needsInstall` field; `config_sync_pull` and
  `/sync-pull` share the same report text.
- `src/connection-block.js` locates, strips and merges the connection row by character offsets, so
  every other byte of the file round-trips unchanged (CRLF and non-ASCII included).

## [0.5.1] - 2026-11-18

### Fixed

- Robustness pass after a full external audit. The plugin page now times out every request
  (status 90 s, push/pull 10 min, configuration 15 s) and always re-enables its controls, so a
  stalled fetch can no longer freeze the card; a hung status read can be retried with Refresh.
- Configuration save failures now surface the server's error code and message
  (`E_CONFIG_INPUT`, `E_CONFIG_BUSY`, …) instead of a generic message, and the effective-value
  verification window grew from ~6 s to ~20 s for slow plugin reloads.
- `git` subprocesses ignore stdin EPIPE instead of potentially crashing the host; Git timeouts now
  report `git <command> timed out after Ns` instead of `unknown git failure`; Windows
  "access is denied" filesystem errors are no longer misclassified as authentication failures.
- Local paths containing `@` (for example `/srv/config@v2.git`) can be saved in the plugin page;
  the `@` restriction now applies only to scp-like remotes.
- The card uses a structured `upToDate` field from the routes instead of regex-matching the report
  text (kept as a fallback for older instances), and `/sync-pull` only treats the whole word
  "apply" as the destructive flag, so "apply-ish" no longer triggers an apply.
- CI jobs carry a 15-minute timeout so a stalled runner fails fast instead of burning the hour.

## [0.5.0] - 2026-11-18

### Added

- Remote repository, branch and profile configuration directly in the Settings and Plugins cards.
- Persistent saves through DSH's configuration editor, with effective configuration readback after
  plugin reload; unrelated configuration is preserved.
- Strict configuration request validation, credential-bearing URL rejection, and explicit warnings
  that profile-layer connection settings can be replaced by Pull.

## [0.4.3] - 2026-11-18

### Added

- Show an indeterminate progress bar while Push or Pull is running; it does not imply a percentage.

## [0.4.2] - 2026-11-18

### Fixed

- Push, preview pull and apply pull now show an immediate success notice, and the clicked button
  reads `Push 中…` / `Pull 中…` while the request is running. Previously a successful push updated
  the remote and the status text but looked like nothing had happened.

## [0.4.1] - 2026-11-17

### Changed

- Put the user-facing promise up front: **一键换机，多端同步 / One-click migration, multi-device
  sync**. The README, Plugin Manager description and Settings/Plugins card now say plainly that the
  plugin manifest and `cordis.patch.yml` are what move between machines.
- Documented the boundary: plugin settings stored in `cordis.patch.yml` (theme, skin, layout, model
  lists) are restored after a pull; plugin-private files, browser storage and credentials are not.
- Fixed the README design table to describe the current host **and** Web UI surface instead of the
  old host-only wording.

## [0.4.0] - 2026-11-17

### Added

- A **Settings → Config sync** section (`settings.section`, id `dsh-config-git-sync`) that reuses
  the same status and pull/push card as the Plugins bundle page. The card remains available on the
  plugin detail page as well.

### Changed

- Package version is now 0.4.0; the browser bundle registers both `settings.section` and
  `plugins.bundle.config`. The suite stays at 155 tests.

## [0.3.0] - 2026-11-17

### Added

- A sync card on the DSH Plugins page (`plugins.bundle.config`): remote, branch, profile, live
  status, refresh, preview pull, confirmed apply pull, and push with an optional commit message.
  The card uses the same `status` / `push` / `pull` implementations as the tools and commands.
- Host JSON routes under `/api/config-sync/{status,push,pull}` for the card, with request
  validation, structured error codes and credential masking. The UI deliberately does not expose
  force; use `/sync-push --force` for that.
- Tests for the route contracts, request validation, credential masking and browser bundle
  registration; the suite now has 154 tests.

### Changed

- Package version is now 0.3.0; `package.json` adds `dsh.client` and the `./client` export, and
  the published files include `client.js`.

## [0.2.0] - 2026-11-17

First public release. The package is published as `dsh-config-git-sync`; the npm names
`dsh-config-sync` and `dsh-sync` were already used by unrelated projects.

### Added

- Conflict-safe push: each machine records its last synced commit and file hashes, and a push
  that would overwrite another machine's changes is refused with `E_CONFLICT` unless forced
  with `--force` or `force: true`.
- Exact-byte synchronization: remote files are read from Git blobs, and push verifies the
  staged and committed bytes, so line-ending attributes and `.gitignore` cannot silently
  change synchronized content.
- Snapshot retention (`snapshotKeep`), automatic rollback when applying a pull fails, and
  atomic writes with transient Windows rename retries.
- Optional `pnpm-workspace.yaml` synchronization via `includeWorkspace`, alongside the
  existing opt-in lockfile support.
- Heuristic inline-credential warning (`secretScan`) for managed files.
- Symlink/submodule rejection and stricter manifest, size and path validation.
- Branch-name validation and orphan commits for branches that do not exist on the remote, including
  deleting stale local refs when a remote branch was deleted.
- Per-remote/branch cache directories and a cross-process `sync.lock` so concurrent profiles and
  tool/command calls cannot clobber one another.
- Ownership-aware mirroring: push preserves remote optional files this machine never synced, and
  pull deletes only files this machine previously synced.
- Status and pull can recover a missing local `package.json`; push still requires it.
- Remote URL masking for userinfo and credential-like query parameters, and control/ANSI
  sanitization of remote-provided manifest fields.
- Push failures are classified as `E_PUSH_REJECTED`, `E_AUTH` or `E_GIT` instead of always
  reporting a rejected push.
- Localized display metadata, plugin detail pages and preview artwork.
- Cross-platform CI, security policy and expanded unit and end-to-end tests.

### Changed

- Package and plugin name changed from `dsh-config-sync` to `dsh-config-git-sync`.
- `reconcile` now defaults to `none`; installing packages (and running their scripts) is opt-in
  because the remote `package.json` is trusted input.
- Commits disable GPG signing and hooks, and use the configured author identity.
- Package-manager reconciliation selects pnpm, then Corepack pnpm, then npm; a real install
  failure no longer falls through to a different package manager, and a missing binary is detected
  by spawn code or the shell's own message.
- Tools and slash commands are registered inside Cordis effects for correct disposal.
- Tool errors extend DSH's `HarnessError`, so structured failure codes reach tool-result metadata;
  messages also carry the code (`E_CONFIG: ...`).
- Pull writes remote files before deleting stale managed files, then verifies each write.
- `engines.dsh` moved to the top-level `engines` field that DSH actually reads; Node requirement is
  now `>=22.19`.

### Fixed

- Status output formatting around the remote commit line.
- A missing remote file referenced by the manifest now reports `E_MANIFEST` instead of a raw
  `ENOENT`.
- A push onto a repository whose branch was deleted now starts a clean root branch instead of
  reusing stale local history.
- `pull` no longer deletes a local `cordis.patch.yml` (or other managed file) that the remote never
  managed, and no longer leaves partially applied files behind when a write or verification fails.
- Slash-command `--force` is recognized only as a leading flag, so a commit message containing
  `-f` cannot silently enable an overwrite.
- `core.autocrlf=true` commit damage now produces a remediation hint instead of an unexplained size
  mismatch.

## [0.1.0] - 2026-11-16

Initial internal version: status, push and pull commands, allowlisted profile files, hash
verification, snapshots and the Git-backed cache.
