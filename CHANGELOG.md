# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
