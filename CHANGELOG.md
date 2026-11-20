# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.7] - 2026-11-20

### Fixed

- **A pull can no longer remove `package.json` or `cordis.patch.yml`.** 0.7.6's
  `E_REMOTE_EMPTY_MANIFEST` refused a manifest with *no* files, but a remote that still carried
  `package.json` and omitted `cordis.patch.yml` — exactly what a branch pushed from a profile that
  had already lost its patch looks like — was accepted, and the converge loop deleted the local
  patch. Both base files are now kept and reported (`kept locally: cordis.patch.yml`) whenever the
  remote copy omits them.
- **Managed files are quarantined, not deleted.** A pull only removes files this machine
  previously synced, and moves them into
  `config-sync/snapshots/<profile>/<stamp>/removed/` instead of unlinking them; the report names
  the directory and the snapshot.
- **Every apply writes a rollback snapshot, even with `snapshot: false`.** The snapshot is built
  beside its final name and published with a rename, so an interrupted pull cannot leave a partial
  rollback point.
- **A destructive pull is refused until forced.** `E_DESTRUCTIVE_PULL` when the remote would drop
  every plugin, or at least half of them while at least five were present. The dry-run preview
  names the removal; `--force` (`/sync-pull apply --force`, the tool's `force: true`, or the card's
  forced confirmation) overrides it.
- **The package install is gated on content.** `E_INSTALL_EMPTY` / `E_INSTALL_SHRINK` skip the
  automatic install when the pulled manifest loses every dependency or at least half of them
  (small profiles are not judged), instead of letting `pnpm install` prune `node_modules`. After
  an install, every dependency the manifest declares is checked against `node_modules` and any
  missing package is reported.
- **Preview and apply are bound together.** The dry-run returns the remote commit; applying with
  `expectedCommit` (the card sends the reviewed one) fails with `E_STALE_PREVIEW` if the branch
  moved in between, so a different diff than the one that was reviewed cannot be written.
- **Manifest and `package.json` are cross-checked.** A manifest whose `plugins` object disagrees
  with the `package.json` it ships fails with `E_MANIFEST_CONFLICT`.

### Fixed (concurrency and lifecycle)

- **A live lock is never reclaimed.** Stale detection now uses the PID in the lock file: a live
  process wins regardless of the file's age, a lock without a PID is stale only after a short
  grace period. Reclaiming renames the file aside and verifies the owner before taking it, and the
  owner token prevents a slow caller from deleting a successor's lock. `isLocked` is read-only.
- **Plugin updates and pulls are serialized.** `updateBundle` / `installBundle` run under the same
  lock as a pull, so the two writers can no longer rewrite `package.json` and `node_modules` at the
  same time.
- **A running update is not reported as failed after three minutes.** The update state carries a
  heartbeat written every 15 s; a run is stale only when the heartbeat stops for 60 s.

### Changed

- The pull report now includes `snapshot`, `destructive`, `missing` and the quarantined files; the
  card polls while the server reports a busy sync, renders a failed last activity as an error, and
  guards the confirm button against a double submit.
- `SECURITY.md` no longer claims `reconcile` defaults to `none` (it defaults to `install`, and the
  install is gated as described above).

### Tests

- New `test/incident-regression.test.js` reproduces the 2026-11-20 shape end to end: a remote
  without `cordis.patch.yml` leaves the local patch untouched, a pull that would wipe the plugin
  list is refused and leaves a snapshot when forced, a stale `expectedCommit` is rejected, and a
  live lock is neither reclaimed nor deleted.

## [0.7.6] - 2026-11-20

### Added

- **Hard safety rails around every destructive operation.** After a user's profile directory
  was found emptied while this plugin was merely running, 0.7.6 makes it structurally
  impossible for the plugin to widen its own blast radius, and loudly reports anything that
  does:
  - **`E_REMOTE_EMPTY_MANIFEST`**: a pull whose remote manifest lists no files (empty or
    corrupt repository) is refused outright instead of deleting every managed file locally.
    A missing `profiles/<channel>/package.json` in the manifest is refused the same way.
  - **`E_PROFILE_EMPTY`**: the post-pull package install is refused when the profile
    directory has no readable `package.json`. Without this guard pnpm sees a workspace
    without projects and prunes `node_modules`.
  - **`E_DELETE_REFUSED`**: every local deletion now goes through an allowlist guard.
    Even a future bug in the delete loop can no longer remove anything outside
    `package.json`, `cordis.patch.yml`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`.
  - **Destructive pulls always snapshot.** A pull that would delete a managed file writes a
    rollback snapshot even when `snapshot: false` is configured.
  - **Package-manager audit.** The pull records the profile's top-level entries before and
    after the install and reports any unmanaged entry that disappeared.
  - The pull output now names the managed files it deleted and where their rollback copies
    live.

## [0.7.5] - 2026-11-19

### Fixed

- **The card could not update the plugin: every click failed with "no plugin manager".** The plugin
  manager is a lazy Cordis service, and the one-shot `get('pluginManager')` on the plugin's outer
  context misses it on the desktop host, so the update route threw `E_UPDATE_UNSUPPORTED` before it
  even recorded a running state — which is why `update.json` never appeared. The card now probes
  every context it was handed (the connection scope included), and, when none has it yet, lets
  Cordis start the service and asks again under a five-second deadline.
- **The version check failed on networks that cannot reach `raw.githubusercontent.com`.** The single
  canonical host is unreachable from mainland China, where the request times out instead of
  failing fast, so "Check for updates" reported nothing even when a newer release existed. The read
  now tries raw.githubusercontent.com, jsDelivr, gcore jsDelivr and github.com in order, stops at
  the first answer, and — when every source fails — reports each host it tried instead of one
  opaque `fetch failed`.

## [0.7.4] - 2026-11-19

### Changed

- **The card is minimal by default.** It now shows only the meta line, **Pull** / **Push**, and the
  outcome notice; connection settings, refresh/test connection, version and the full status text
  moved under a collapsed **More**. The version check runs lazily when **More** is first opened
  instead of on mount.
- **Pull and push confirm before writing.** Pull still runs a read-only preview first, but the diff
  now opens in a confirmation dialog; push opens its dialog immediately (with the optional commit
  message). Neither writes anything until the dialog is confirmed, so a stray click can no longer
  overwrite local files or the remote branch.

### Fixed

- **`E_REMOTE_EMPTY` on a machine whose profile directory is named differently.** The remote
  manifest lookup only tried `profiles/<local profile>/`, so a remote holding `profiles/desktop/`
  looked empty on a machine whose profile was `web`. Pull and status now adopt the remote's single
  profile directory on first use, record the mapping as `channel` in `state.json`, and keep writing
  into the local profile's own directory; the output and card show `profile → channel`. When the
  remote holds several profiles the plugin no longer guesses: it reports `E_REMOTE_PROFILE` with the
  available names. A genuinely empty branch keeps `E_REMOTE_EMPTY`, with wording that no longer
  tells the user to push from a machine that has not pushed either.

## [0.7.3] - 2026-11-19

### Added

- **In-card plugin update.** The bundle card's footer now shows this plugin's own
  version and checks the repository's `package.json` on GitHub once when the card
  mounts (silently: an offline host sees the plain **Check for updates** action
  instead of an error). A newer release turns the row into **Update to x.y.z**,
  which hands the installation to DSH's own `pluginManager`
  (`updateBundle` for a commit-pinned copy, `installBundle` otherwise) so the
  manager replaces the running plugin in place and rolls the previous copy back
  when the installation fails. Because the install unloads the plugin serving the
  request, the host answers `202` first and writes the outcome to
  `$DSH_HOME/config-sync/update.json`, which the card polls through
  `GET /api/config-sync/update-state`; a failed attempt is reported with its
  reason and can be retried from the same row. While a sync holds the lock the
  update is refused with the same `E_BUSY` answer the other controls use, so it
  cannot reinstall the plugin underneath a running Git operation. The new spec
  pins the full commit (`github:owner/repo#<sha>`), so DSH's native Plugins page
  gains update and rollback for this bundle as well. Local (`link:`, `file:`,
  path) installs get an explanation instead of a button, and a host that cannot
  read the profile explains what it needs. The row shows the target version only
  while an update is actually offered: a copy pinned to a commit can sit ahead of
  the branch it was pinned from, and an arrow would read as an instruction to
  downgrade. New routes: `GET|POST /api/config-sync/update` and
  `GET /api/config-sync/update-state`.

## [0.7.2] - 2026-11-19

### Fixed

- **Test connection failed on every machine with `E_SYNC git.indexEntries is
  not a function`** (0.7.1 regression). The 0.7.1 fix made the probe re-commit
  the existing synced files, so `probeRemote` began calling `indexEntries`, but
  `testConnection` hands the probe a hand-built git adapter and that adapter was
  never given the new helper. The probe's own e2e tests pass the whole git
  module, so they stayed green while the real button failed. The adapter now
  includes `indexEntries`, and a new e2e test drives `testConnection` itself
  against a remote that already holds synced files.

### Changed

- **The bundle card now reads as three plain steps.** A status card shows the
  verdict, remote/branch/profile facts, Refresh and Test connection. A sync card
  splits Pull from remote and Push to remote, with the pull preview rendered in
  place and gated behind **Apply pull** / **Cancel**. Connection settings and the
  full status text moved into collapsed sections that open automatically on first
  run or when configuration cannot be loaded. The card uses the host theme tokens
  and adapts to narrow layouts, and the preview hides the CLI-only identity block
  and `/sync-pull apply` instruction already represented by the buttons.

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
