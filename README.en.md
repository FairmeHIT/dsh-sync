# dsh-config-git-sync

> **One-click migration. Multi-device sync.**
>
> Your plugin manifest and `cordis.patch.yml` travel through **your own private Git repository**.
> Pull on a new machine, install dependencies, restart, and keep working. “One-click” covers the
> plugin manifest and config overlay; credentials, sessions and plugin-private data stay out.

English | [中文](README.md)

> **Repository and package names differ**: the repository is
> [`FairmeHIT/dsh-sync`](https://github.com/FairmeHIT/dsh-sync), and the npm package is
> `dsh-config-git-sync`. The npm names `dsh-config-sync` and `dsh-sync` are already used by
> unrelated projects, so this package uses its own name.

## Scope and design

This project does one thing: **sync the plugin manifest and `cordis.patch.yml` of any profile
(desktop included) through a private Git repository on current DSH 0.2.2-rc.3 / 0.2.x.** It
deliberately does not cover settings, credentials, agent presets or whole-machine backup; those
have their own tools and risk boundaries, and mixing them in would make the sync surface too broad.

Our trade-offs:

| Choice | Why |
|---|---|
| Sync only the profile's `package.json` + `cordis.patch.yml` (optional workspace/lock) | These files must agree across machines, while settings, credentials and presets stay out of the sync surface |
| Support any profile, including `desktop` | Desktop users are a first-class case |
| Refuse a conflicting push instead of auto-merging | Config files are whole-document semantics; make the user pull or explicitly force rather than silently overwrite another machine |
| Read Git blobs; verify staged and committed bytes | Line endings, `.gitattributes` and `.gitignore` must not change managed content |
| Pull deletes only files this machine previously synced | A first pull must not remove a local `cordis.patch.yml` or other unmanaged files |
| `reconcile: install` by default | Pulled dependencies are installed automatically; set `none` for an untrusted repository |
| The synced copy drops this machine's `config-sync` row | The repository URL is machine-local; the row never reaches the remote, so it can never be written back over local settings |
| Host tools + Web UI | Commands/tools work in desktop and headless; the web shell gets a Settings page and plugin-page card |
| State + cross-process lock + snapshots | Avoid silent overwrites and half-written files across machines/sessions |

This is not an all-in-one DSH configuration backup tool. It fits workflows that want the plugin
manifest and config overlay under Git review without putting API keys or machine-local settings in
the repository. If you need graphical line-level merge for settings/presets, or encrypted
whole-machine migration including API keys, choose a tool dedicated to that job.

## Highlights

- **Only the right files**: the plugin manifest, `cordis.patch.yml`, and optional
  `pnpm-workspace.yaml` / `pnpm-lock.yaml`.
- **Byte-exact sync**: remote content is read from Git objects, and push verifies the staged and
  committed bytes. Line-ending attributes and `.gitignore` cannot silently rewrite config.
- **Conflict protection**: each machine records its last synced commit and file hashes. A push
  that would overwrite another machine's changes is refused unless explicitly forced.
- **A page, not just commands**: see the remote, branch, last sync and diff on the plugin page or
  under **Settings → Config sync**, then Pull or Push from there; it uses the same sync logic as
  the slash commands.
- **Recoverable**: `pull apply` snapshots first and automatically rolls back managed files if a
  write or verification fails.
- **Credential isolation**: `.credentials.yaml`, sessions, skills, memories, attachments and
  `node_modules` are never in the allowlist.
- **Plain Git**: SSH, HTTPS or a local path. Git runs non-interactively and never opens a login
  prompt.

## What it syncs

| Synced | Notes |
|---|---|
| `profiles/<profile>/package.json` | `dsh.profile.bundles` and `dependencies`, i.e. the plugin manifest |
| `profiles/<profile>/cordis.patch.yml` | Model, UI and plugin config overlay |
| `profiles/<profile>/pnpm-workspace.yaml` | Optional, enabled with `includeWorkspace: true`; carries `allowBuilds` and similar install settings |
| `profiles/<profile>/pnpm-lock.yaml` | Optional, enabled with `includeLockfile: true` |
| `profiles/<profile>/manifest.json` | Hashes, sizes, plugin summary and device provenance |

One line inside `profiles/<profile>/cordis.patch.yml` is the exception: this machine's own
`- id: config-sync` row is stripped on push, so it never reaches the repository, and merged back
after a Pull applies. The repository URL therefore survives a Pull.


**Never synced**: `.credentials.yaml`, sessions, `storages/`, skills, memories, attachments,
`node_modules/`, `.plugin-manager/`, `.dsh-market/`, workspace registries or workspace files. The
plugin only reads allowlisted files, and rejects a remote profile directory that contains any
path outside the allowlist (`E_PATH`).

### Does it sync a plugin's own settings?

It depends on where the plugin stores them. DSH bundle / plugin settings usually live in the
profile's `cordis.patch.yml`, for example:

```yaml
- id: ui-theme
  config:
    preference: light
- id: ui-skin-claude-style
  config:
    brand: deepseek
    typeface: claude
```

Those rows travel with `cordis.patch.yml`, so theme, skin, layout, model lists and similar overlay
settings are restored after a Pull. If a plugin keeps state in its own data file, browser
localStorage, `settings.yaml`, `.credentials.yaml` or its package directory, that path is not in
the allowlist and is not synced; recreate it on the new machine.

One repository can hold several profiles under `profiles/<profile>/` without interference. The
manifest records a random device id, hostname, platform and DSH version as provenance; keep the
repository private.

## How it works

1. Edit the plugin list or config on one machine.
2. `/sync-push` mirrors the managed files into one Git commit and pushes it.
3. On another machine, `/sync-status` shows the diff, `/sync-pull` previews it, and
   `/sync-pull apply` applies it.
4. Restart DeepSeek Harness so the new `cordis.patch.yml` and plugin list take effect.

Repository layout:

```
profiles/<profile>/package.json
profiles/<profile>/cordis.patch.yml
profiles/<profile>/pnpm-workspace.yaml     # optional
profiles/<profile>/pnpm-lock.yaml          # optional
profiles/<profile>/manifest.json           # hashes, plugin summary, device info
```

Local state and cache live under `$DSH_HOME/config-sync/`:

| Path | Purpose |
|---|---|
| `work/<remote+branch hash>/` | Plugin-owned Git work tree keyed by remote and branch, separate from the profile |
| `state.json` | Last successful push/pull commit and file hashes per profile (0600 on POSIX) |
| `sync.lock` | Serializes sync operations in one Harness home |
| `snapshots/<profile>/<timestamp>/` | Pre-apply snapshots (0600 on POSIX) |
| `device.json` | A random UUID used only as a provenance hint in the manifest |

## Install

Requires `dsh >= 0.2.2-rc.3 < 0.3.0` and Git 2.28+. The plugin uses the Node bundled with DSH;
no separate Node installation is needed.

From GitHub (recommended):

```sh
dsh plugin --profile desktop add github:FairmeHIT/dsh-sync
```

From a local checkout:

```sh
dsh plugin --profile desktop add D:\path\to\dsh-sync
```

Once published on npm:

```sh
dsh plugin --profile desktop add dsh-config-git-sync
```

Restart DSH after installing.

## Configure

Prefer the **`$DSH_HOME/cordis.patch.yml`** home layer (default `~/.dsh/cordis.patch.yml`). It is
not synced, so every machine can keep its own path and settings:

```yaml
- id: config-sync
  config:
    remote: 'git@github.com:you/dsh-config.git'
    branch: main
    profile: desktop
```

You can also put it in `~/.dsh/profiles/desktop/cordis.patch.yml`. That file is synced, but the
`- id: config-sync` row itself is not: it is stripped on push and merged back after a Pull applies,
so every machine keeps its own repository URL. The home layer is still the safer choice, because it
has higher priority and is untouched by profile-level sync.

| Field | Default | Meaning |
|---|---|---|
| `remote` | empty (required) | Private repository URL: SSH, HTTPS or a local path |
| `branch` | `main` | Branch to read and write; a missing branch becomes a fresh root commit, not a copy of another branch |
| `profile` | empty | Profile name; empty auto-detects the profile that references this plugin |
| `dshHome` | empty | Harness home; falls back to `$DSH_HOME`, then `~/.dsh` |
| `includeLockfile` | `false` | Also sync `pnpm-lock.yaml` |
| `includeWorkspace` | `false` | Also sync `pnpm-workspace.yaml` (needed to reproduce `allowBuilds` across machines) |
| `reconcile` | `install` | Install packages after a pull. The default installs automatically so pulled plugins work on a new machine; `none` only writes files and prints the manual install command. `install` runs package scripts selected by the remote `package.json`, which trusts the repository |
| `snapshot` | `true` | Write a pre-apply snapshot |
| `snapshotKeep` | `20` | Snapshots to keep per profile; `0` keeps all |
| `secretScan` | `warn` | Warn about likely inline credentials; `off` disables |
| `gitBin` | `git` | Git executable |
| `authorName` / `authorEmail` | `dsh-config-git-sync` / `dsh-config-git-sync@localhost` | Commit identity |

When auto-detecting, multiple matching profiles prefer `desktop`, then `web`; if the choice is
still ambiguous the plugin reports `E_PROFILE`, so set `profile` explicitly.

### Authentication

Git runs non-interactively (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=Never`): it never opens a
login prompt and never stores a token.

- **SSH recommended**: set up `ssh -T git@github.com` first.
- HTTPS: cache credentials once with Git Credential Manager, or use a credential helper.
- Do not embed a token in the `remote` URL.

## Usage

### Plugin page and Settings

After restarting DSH there are two entry points:

- **Settings → Config sync**: the full status and action card, intended for everyday use.
- Sidebar **Plugins** → the `dsh-config-git-sync` bundle page: the same card, reachable from the
  plugin detail page.

The card shows the remote, branch, profile and current status. On a new machine, enter the private repository URL, branch (default `main`) and profile (blank for auto-detection) in the configuration form. Choose **Save configuration**, wait for effective readback verification, then refresh status or preview Pull. URLs containing passwords or tokens are rejected; configure a Git credential helper or SSH beforehand.

**Storage:** the UI uses DSH's configuration editor to save in the running profile's configuration overlay, preserving unrelated fields. That file is also managed by sync, but this machine's `- id: config-sync` row is treated as machine-local data: it is stripped on push and merged back after a Pull applies, so the saved repository URL is not cleared by Pull. The pull output reports `preserved: config-sync row (this machine)` and the card says so after applying. If a home or command-line overlay overrides the edited fields, the editor rejects the save; it does not rewrite higher-priority configuration.

- The card shows the remote, branch, profile and current status. **Refresh** is read-only.
- **Preview pull** is the same as `/sync-pull`; it writes nothing.
- **Apply pull** asks for confirmation, snapshots, then overwrites managed local files. This
  machine's `config-sync` row is preserved.
- Apply pull installs dependencies by default (`reconcile: install`). When the pull changed `package.json`,
  a lockfile or the plugin list, the plugin runs `pnpm install` (or corepack/npm fallbacks) in the profile
  directory and reports `packages: installed with <tool>`. With `reconcile: none` the output instead states
  `packages: manifest changed but dependencies were not installed` and
  `next: dsh plugin --profile <profile> install`. Restart after installing.
- **Push** accepts a commit message. The UI does not expose force; use `/sync-push --force` when
  needed.
- If the card is missing, confirm the plugin is installed and DSH restarted, then check
  `config.remote` in `~/.dsh/cordis.patch.yml`; the route is `/api/config-sync/status`.

### Slash commands

| Command | Effect |
|---|---|
| `/sync-status` | Fetch and show file/plugin differences and whether the remote moved since the last sync; read-only |
| `/sync-push [--force] [message]` | Commit and push the current profile's managed files |
| `/sync-pull` | Dry run: preview remote changes, write nothing |
| `/sync-pull apply` | Apply remote changes: snapshot first, then atomic writes |

### Model tools

| Tool | Notes |
|---|---|
| `config_sync_status` | Read-only comparison with last-sync information |
| `config_sync_push` | Push; accepts `message` and `force` |
| `config_sync_pull` | Dry run unless `apply: true` |

### First run

1. Create an empty private repository (for example `dsh-config`).
2. On machine A: install the plugin, configure it, restart.
3. On machine A: run `/sync-push`.
4. On machine B: install the plugin, configure it, restart.
5. On machine B: run `/sync-status`, then `/sync-pull`, then `/sync-pull apply`.
6. Restart DSH.

Machine B's `config-sync` row survives `apply`: machine A's copy does not contain it, and the local
row is merged back. The home layer is still the safer place to keep it.

`reconcile` defaults to `install`, so `pull apply` writes files and then runs the package manager in
the profile — a new machine is ready after a restart. With `none` the output and the card name the
next step instead: `dsh plugin --profile <profile> install`.

### Let the new machine's DSH do the install (optional)

If DSH is already running on the new machine and the current session has shell/file tools, paste the
two prompts below. **This is not fully unattended**: DSH must be restarted after installing the
plugin, the second prompt is for after that restart, and one more restart is needed after
dependencies are installed. Configure Git authentication (SSH key or HTTPS credential) first, and
replace `YOURNAME`, `desktop` and the path with real values.

**Prompt 1 (before restart)**

```text
Install and configure DSH sync on this machine:
1. Run dsh plugin --profile desktop add github:FairmeHIT/dsh-sync.
2. Create ~/.dsh/cordis.patch.yml if it does not exist. If it exists, append the block below to the end of the array; do not overwrite existing content:
- id: config-sync
  name: dsh-config-git-sync
  config:
    remote: 'git@github.com:YOURNAME/dsh-config.git'
    branch: main
    profile: desktop
3. Read ~/.dsh/cordis.patch.yml back and confirm remote is nested under config: (four-space indent), not directly under id. If the file cannot be written, paste the complete YAML back to me for a manual fix; do not just reply that it is done.
4. Do not write this to the profile's cordis.patch.yml. When done, tell me to restart DSH; do not try to restart or terminate the current process.
```

**Prompt 2 (after restart)**

```text
Continue the DSH config sync:
1. Call config_sync_status to inspect differences.
2. Call config_sync_pull with apply: true to apply the remote config.
3. Run dsh plugin --profile desktop install to install profile dependencies.
4. When done, tell me to restart DSH again; do not try to restart or terminate the current process.
```

If the tools are unavailable, use `/sync-status`, `/sync-pull`, and `/sync-pull apply` instead of
steps 1–2 in the second prompt.

## Conflicts, force and snapshots

**Push rules**:

- No manifest on the remote: publish normally.
- Local and remote content already match: no empty commit; only local state is updated.
- The remote moved since this machine's last sync: refuse (`E_CONFLICT`) and ask for a pull; to
  overwrite deliberately, use `/sync-push --force` (or `force: true`).
- A fresh machine pushing to a non-empty remote: refused as well; pull to adopt the remote, or
  force explicitly.

**Pull rules**:

- `/sync-pull` is a dry run.
- `/sync-pull apply` overwrites local managed files and deletes only managed files this machine
  previously synced and that are now absent remotely. A local file this machine never synced (for
  example a local `cordis.patch.yml` during a first pull) is kept and reported as `kept locally`.
  It snapshots first.
- If the local profile also changed since the last sync, the output lists the overwritten files;
  the snapshot is still available.
- If a write or verification fails, managed files are rolled back and the command reports
  `E_APPLY`.

**No automatic merge.** When both machines changed things, the first explicit pull or force
decides the result. Git history keeps every step, but the conflict itself needs a human decision.

## Safety boundaries

- **Allowlist**: only `package.json`, `cordis.patch.yml`, optional `pnpm-workspace.yaml` /
  `pnpm-lock.yaml`, and `manifest.json`.
- **Path validation**: rejects `..`, absolute paths, NUL bytes, other profiles, unknown files, and
  any path outside the allowlist inside the profile directory.
- **File type validation**: remote manifests and managed files must be regular files; symlinks and
  submodules are rejected.
- **Hash and size verification**: every remote file is checked against the SHA-256 and size in
  `manifest.json`; mismatches fail closed.
- **Byte-exact writes**: remote content is read from Git blobs; push stages exact bytes with
  filters and `.gitignore` bypassed, then verifies the commit again.
- **Atomic writes**: write to a temporary sibling, then rename; transient Windows locks are
  retried.
- **Snapshots and rollback**: `pull apply` saves the current managed files under
  `$DSH_HOME/config-sync/snapshots/<profile>/`, and restores them if applying fails. State, snapshot
  and device files use 0600 permissions on POSIX.
- **Credentials untouched**: `.credentials.yaml` is not on the allowlist and is never opened.
- **Isolated cache**: the Git work tree lives in `$DSH_HOME/config-sync/work/<hash>`, keyed by
  remote and branch, and `sync.lock` serializes operations so concurrent syncs cannot clobber each
  other.
- **Default installs**: `reconcile` defaults to `install`, so pulled plugins work on a new machine
  without a manual step. Set it to `none` for a repository you do not trust; no installer runs then.
- **Secret heuristic**: push warns about obvious inline keys and tokens, but this is **not a
  guarantee**. Keep the repository private and prefer environment variables.
- **Commit hygiene**: commits use the configured identity with GPG signing and hooks disabled, so
  global Git settings cannot block a sync.

## Behavior details

- `push` mirrors the managed files. It removes only managed files this machine previously synced
  and that no longer exist locally (for example the lockfile after this machine turns
  `includeLockfile` off). Remote optional files this machine never synced are preserved and
  reported as `preserved`.
- `push` is a no-op when content is unchanged; it does not create empty commits.
- `pull apply` writes remote managed files locally; managed files this machine synced and that are
  absent remotely are deleted, while files it never synced are kept and reported as `kept locally`.
  A missing local `package.json` no longer blocks status or pull, so the normal recovery path can
  restore it; push still refuses a profile without `package.json`.
- When `package.json`, a lockfile or the workspace file changes and `reconcile=install`, the plugin
  tries `pnpm install`, then `corepack pnpm install`, then
  `npm install --no-audit --no-fund`. A real install failure stops there instead of letting a
  different package manager overwrite the result.
- `link:` / `file:` / `workspace:` dependencies cannot be restored across machines and are
  reported as manual work.
- A configured branch that does not exist on the remote is created as a new root commit containing
  only this profile's managed files, without dragging unrelated history along. If the remote branch
  is deleted, the next push also rebuilds a root commit instead of pushing the old tip back.
- Device information is provenance only; it is not used for authorization.
- `status`, `push` and `pull` are serialized in one Harness home by `sync.lock`; waiting more than two
  minutes reports `E_BUSY`, and a lock left by a crashed process is reclaimed by PID or age.

## Limitations

- **No three-way merge.** Resolve divergence by pulling or forcing; the last explicit action wins.
- Sessions, skills, memories, attachments, workspace registries and plugin-manager caches are out
  of scope.
- Host tools plus a Web UI card: slash commands and model tools everywhere, with the same card in
  Settings and on the plugin page where the web shell runs.
- Tested on Windows; macOS and Linux use the same Node + Git path and are covered by CI, but a real
  desktop run on each platform is still recommended.
- The npm package name differs from the repository name; install from GitHub or a local directory
  until the package is published.
- This plugin's own install spec is part of `package.json`. If one machine uses `link:D:\...`, the
  other receives the same local path after a pull. Use the GitHub or npm package on all machines,
  or fix that dependency manually.
- `pnpm-workspace.yaml` may contain machine-specific `allowBuilds` /
  `minimumReleaseAgeExclude` settings. Enabling `includeWorkspace` syncs them; make sure that is
  what you want.
- `cordis.patch.yml` can legitimately contain inline provider credentials. The secret scan is a
  heuristic; review the diff before pushing.
- `reconcile` defaults to `install`. The remote `package.json` (and the optional workspace file)
  chooses packages and install scripts, so keep the default only for a trusted repository; set `none`
  otherwise.
- The plugin verifies exact Git bytes. If another machine commits with `core.autocrlf=true` and
  rewrites line endings, the remote reports `E_MANIFEST`; re-commit the managed files with
  `core.autocrlf=false`. The plugin's own cache always disables line-ending conversion.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `E_CONFIG` | `remote` is missing, or `branch` is invalid; see the config example |
| `E_PROFILE` | Several profiles matched, or the detected directory name is not a safe path segment; set `profile` explicitly |
| `E_PROFILE_MISMATCH` | The remote manifest names a different profile; check `profile` or the repository path |
| `E_CONFLICT` | The remote moved since the last sync; run `/sync-pull`, then `/sync-push --force` if you really mean to overwrite |
| `E_AUTH` | Push could not authenticate or find the repository; check the remote URL, SSH key or HTTPS credentials |
| `E_BUSY` | Another sync holds `sync.lock`; wait for it, or remove the lock file if the process is gone |
| `E_PUSH_REJECTED` | The remote moved between fetch and push; run `/sync-status` again, pull, then push |
| `E_MANIFEST` | Corrupt or unsupported remote manifest, missing file, or a hash/size mismatch |
| `E_PATH` | The repository contains a path outside the allowlist or an unsafe file type; the plugin refuses it |
| `E_REMOTE_EMPTY` | The remote has no manifest for this profile yet; push from a configured machine first |
| `E_APPLY` | A pull write or verification failed; managed files were rolled back, so check disk space and permissions, then retry |
| `E_GIT` / `E_CANCELLED` | Git failed or the operation was cancelled; check the Git installation, network, authentication and logs |
| `E_CONFIG_INPUT` | The remote/branch/profile typed in the plugin page is invalid; use a credential-free HTTPS/SSH URL or a server-trusted local path |
| `E_CONFIG_BUSY` / `E_CONFIG_SAVE` | A configuration save is already in progress or failed; wait for the plugin to reload and retry, and check higher-priority overrides |
| `E_CONFIG_TIMEOUT` / `E_TIMEOUT` | A plugin-page request timed out (save 15s / read 90s / sync 10min); retry on a slow network |
| `E_HTTP` | A plugin-page request failed (route unresponsive or non-JSON response); refresh the page, restart DSH if needed |
| Git authentication failure | Set up an SSH key or cache HTTPS credentials; the plugin never prompts |
| Nothing changed after a pull | Restart DSH; `cordis.patch.yml` is composed at boot |

`E_CONFIG` means the plugin is loaded but its config has no `remote`; if the plugin were missing,
`config_sync_status` would not exist. Check that `~/.dsh/cordis.patch.yml` is a top-level array and
`remote` is nested under `config:`:

```yaml
- id: config-sync
  name: dsh-config-git-sync
  config:
    remote: 'git@github.com:YOURNAME/dsh-config.git'
    branch: main
    profile: desktop
```

If `remote` is aligned with `id`, or the block was written into the profile `cordis.patch.yml`, it is
not read; the latter is also overwritten by a pull. Fully quit and restart DSH.

## Development

```sh
npm install
npm test              # unit + Git end-to-end tests
npm run test:e2e      # end-to-end only
npm run pack:check    # inspect the npm package contents
```

Tests use `node:test` and create bare repositories plus fake DSH homes in temporary directories.
They never touch the network or the real `~/.dsh`. CI runs on Ubuntu, Windows and macOS with Node
22 and 24.

```
index.js             Plugin entry: 3 tools + 3 slash commands
src/config.js        Schemastery config, branch validation, DSH_HOME resolution
src/paths.js         Profile detection, device id, atomic writes, hashing, DSH version
src/state.js         Per-machine last-sync state
src/lock.js          Cross-process sync lock
src/text.js          Remote text sanitization and list summaries
src/manifest.js      Manifest build/parse, diff, path validation, optional files
src/git.js           Git wrapper: object reads, tree validation, exact staging, commit and push
src/sync.js          status / push / pull orchestration, conflicts, snapshots, rollback, installs
src/secrets.js       Inline-credential heuristic
locale/              Plugin Manager display metadata
docs/                Detail-page documents and preview art
test/                Unit tests + Git end-to-end tests
```

Local load check:

```sh
dsh plugin --profile scratch add D:\path\to\dsh-sync
dsh --profile scratch --dump-config
```

## License

MIT. See [LICENSE](LICENSE).
