# dsh-config-git-sync

> **一键换机，多端同步。**
>
> 插件清单和 `cordis.patch.yml` 跟着你自己的 **私有 Git 仓库**走；新电脑 Pull 一下，装依赖、重启，
> 插件和配置接着用。一键指的是插件清单与配置覆盖层，凭据、会话和插件私有数据不进仓库。

[English](README.en.md) | 中文

> **仓库名与包名不同**：仓库是 [`FairmeHIT/dsh-sync`](https://github.com/FairmeHIT/dsh-sync)，npm 包名是
> `dsh-config-git-sync`。npm 上的 `dsh-config-sync` 和 `dsh-sync` 已被其他项目占用，所以这里使用独立包名。

## 设计范围与取舍

本项目只做一件事：**在当前 DSH 0.2.2-rc.3 / 0.2.x 上，把任意 profile（包括 `desktop`）的插件清单和
`cordis.patch.yml` 通过私有 Git 同步。** 它刻意不覆盖 settings、凭据、agent presets 或整机备份；
这些内容有各自的工具和风险边界，混在一起会让同步面过大。

我们的取舍：

| 取舍 | 原因 |
|---|---|
| 只同步 profile 的 `package.json` + `cordis.patch.yml`（可选 workspace/lock） | 这两类文件跨机器最需要一致，同时避免把 settings、凭据、presets 混进同步面 |
| 支持任意 profile，包括 `desktop` | 不把桌面用户排除在外 |
| push 冲突默认拒绝，而不是自动合并 | 配置文件是整体语义；宁可让用户 pull 或显式 force，也不静默覆盖另一台机器的改动 |
| 从 Git blob 读取，push 校验暂存和提交字节 | 换行、`.gitattributes`、`.gitignore` 不应改变受管文件内容 |
| pull 只删除本机同步过的文件 | 首次 pull 不误删本地已有的 `cordis.patch.yml` 等未受管文件 |
| 默认 `reconcile: none` | 远端 `package.json` 不应在默认配置下触发安装脚本 |
| host 工具 + Web UI | 命令/工具在 desktop/headless 都能用；Web 端提供设置页和插件页卡片 |
| state + 跨进程锁 + 快照 | 多机器/多会话并发时避免静默覆盖和半写 |

这不是一个“大而全”的 DSH 配置备份工具。它适合希望把插件清单和配置覆盖层纳入 Git 审计、又不想让
API 密钥和机器本地设置进入仓库的场景。如果你需要 settings/presets 的图形化逐行合并，或包含 API key
的加密整机迁移，请选择专门做这些的工具。

## 特性

- **只同步该同步的**：插件清单、`cordis.patch.yml`，以及可选的 `pnpm-workspace.yaml` / `pnpm-lock.yaml`。
- **字节级一致**：从 Git 对象读取远端内容，push 前校验暂存区和提交后的字节，行尾设置和
  `.gitattributes` 无法悄悄改写配置。
- **冲突保护**：每台机器记录上次同步的提交和文件哈希。会覆盖其他电脑改动的 push 默认被拒绝，
  必须显式 `--force`。
- **可视化**：在 DSH 的插件页面或 **设置 → 配置同步** 查看远端、分支、上次同步和差异，直接点 Pull / Push；与斜杠命令
  走同一套同步逻辑。
- **可恢复**：`pull apply` 前写快照；写入或校验失败时自动回滚本地受管文件。
- **凭据隔离**：`.credentials.yaml`、session、skills、memories、附件和 `node_modules` 永远不在允许列表内。
- **纯 Git**：SSH、HTTPS 或本地路径都行；插件以非交互方式调用 Git，不弹登录框。

## 同步什么

| 同步 | 说明 |
|---|---|
| `profiles/<profile>/package.json` | profile 的 `dsh.profile.bundles` 与 `dependencies`，即插件清单 |
| `profiles/<profile>/cordis.patch.yml` | 模型、UI、插件配置的覆盖层 |
| `profiles/<profile>/pnpm-workspace.yaml` | 可选：`includeWorkspace: true` 时同步，包含 `allowBuilds` 等安装设置 |
| `profiles/<profile>/pnpm-lock.yaml` | 可选：`includeLockfile: true` 时同步 |
| `profiles/<profile>/manifest.json` | 哈希、大小、插件摘要、设备信息 |

**绝不同步**：`.credentials.yaml`、sessions、`storages/`、skills、memories、附件、`node_modules/`、
`.plugin-manager/`、`.dsh-market/`、工作区注册表或工作区文件。插件只读取允许列表中的文件；
profile 目录里出现允许列表之外的路径时，远端读取会直接拒绝（`E_PATH`）。

### 插件自己的配置会同步吗？

看配置存在哪里。DSH 的 bundle / 插件配置通常写在 profile 的 `cordis.patch.yml`，例如：

```yaml
- id: ui-theme
  config:
    preference: light
- id: ui-skin-claude-style
  config:
    brand: deepseek
    typeface: claude
```

这些行会随 `cordis.patch.yml` 一起同步，新机器 Pull 后就能恢复主题、皮肤、界面布局、模型列表等
覆盖层配置。若某个插件把设置存在自己的数据文件、浏览器 localStorage、`settings.yaml`、
`.credentials.yaml` 或插件目录，这些不在允许列表内，不会同步，需要在新机器重新设置。

一个仓库可以放多个 profile，各自位于 `profiles/<profile>/`，互不影响。`manifest.json` 会记录一个
随机设备 ID、主机名、平台和 DSH 版本，仅用于来源提示；请保持仓库私有。

## 工作方式

1. 在 A 机改好插件和配置。
2. `/sync-push`：把受管文件镜像到一个 Git 提交并推送。
3. 在 B 机 `/sync-status` 看差异，`/sync-pull` 预览，`/sync-pull apply` 应用。
4. 重启 DeepSeek Harness，让新的 `cordis.patch.yml` 和插件清单生效。

仓库结构：

```
profiles/<profile>/package.json
profiles/<profile>/cordis.patch.yml
profiles/<profile>/pnpm-workspace.yaml     # 可选
profiles/<profile>/pnpm-lock.yaml          # 可选
profiles/<profile>/manifest.json           # 哈希、插件摘要、设备信息
```

本地状态与缓存都在 `$DSH_HOME/config-sync/` 下：

| 路径 | 用途 |
|---|---|
| `work/<remote+branch 哈希>/` | 插件私有的 Git 工作副本，与 profile 分离；不同远端/分支互不干扰 |
| `state.json` | 每个 profile 上次成功 push / pull 的提交和文件哈希（POSIX 权限 0600） |
| `sync.lock` | 串行化同一 Harness home 下的同步操作，防止并发写坏缓存或状态 |
| `snapshots/<profile>/<时间戳>/` | `pull apply` 前的本地快照（POSIX 权限 0600） |
| `device.json` | 仅含一个随机 UUID，用于 manifest 里的来源提示 |

## 安装

要求：`dsh >= 0.2.2-rc.3 < 0.3.0`、Git 2.28+。插件使用 DSH 自带的 Node，无需单独安装 Node。

从 GitHub 安装（推荐）：

```sh
dsh plugin --profile desktop add github:FairmeHIT/dsh-sync
```

从本地 checkout 安装：

```sh
dsh plugin --profile desktop add D:\path\to\dsh-sync
```

npm 发布后也可以：

```sh
dsh plugin --profile desktop add dsh-config-git-sync
```

安装后重启 DSH。

## 配置

推荐把同步配置放在 **`$DSH_HOME/cordis.patch.yml`**（默认 `~/.dsh/cordis.patch.yml`）。这个文件不会被
同步，因此每台机器可以有自己的路径和设置：

```yaml
- id: config-sync
  config:
    remote: 'git@github.com:you/dsh-config.git'
    branch: main
    profile: desktop
```

也可以写在 `~/.dsh/profiles/desktop/cordis.patch.yml`。注意：该文件本身会被同步，所以要么所有机器使用
完全相同的 `remote` / `profile` / `branch`，要么把同步配置放在 home 级文件里，避免被远端版本覆盖。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `remote` | 空（必填） | 私有仓库地址，支持 SSH / HTTPS / 本地路径 |
| `branch` | `main` | 读写分支；分支不存在时会创建新的根提交，不会拖带其它分支历史 |
| `profile` | 空 | profile 名；留空自动探测引用了本插件的 profile |
| `dshHome` | 空 | Harness home；留空用 `$DSH_HOME`，再退到 `~/.dsh` |
| `includeLockfile` | `false` | 是否同步 `pnpm-lock.yaml` |
| `includeWorkspace` | `false` | 是否同步 `pnpm-workspace.yaml`（跨机器复现 `allowBuilds` 时开启） |
| `reconcile` | `none` | pull 应用后是否装依赖。默认只写文件；设为 `install` 会执行远端 `package.json` 选择的包安装脚本，属于信任远端仓库的操作 |
| `snapshot` | `true` | pull 应用前写本地快照 |
| `snapshotKeep` | `20` | 每个 profile 保留的快照数量；`0` 表示全部保留 |
| `secretScan` | `warn` | 检测到疑似内联凭据时警告；`off` 关闭 |
| `gitBin` | `git` | Git 可执行文件 |
| `authorName` / `authorEmail` | `dsh-config-git-sync` / `dsh-config-git-sync@localhost` | 提交身份 |

自动探测 profile 时，如果多个 profile 都引用了本插件，会优先 `desktop`，其次 `web`；仍无法确定时
报 `E_PROFILE`，请显式设置 `profile`。

### 认证

插件以非交互方式调用 Git（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`），不会弹出账号密码框，
也不会保存 token。

- **推荐 SSH**：提前配好 `ssh -T git@github.com`。
- HTTPS：先用 Git Credential Manager 缓存一次凭据，或使用带凭据的 credential helper。
- 不要把 token 直接写进 `remote` URL。

## 使用

### 插件页面与设置页

重启 DSH 后，有两个入口：

- **设置 → 配置同步**：完整的状态与操作卡片，适合日常使用。
- 侧边栏 **插件** → `dsh-config-git-sync` 的 bundle 页面：同一张卡片，方便从插件详情进入。

卡片会显示远端、分支、profile 和当前状态。

- 卡片显示远端、分支、profile 和当前状态；**刷新** 只读，不会写盘。
- **预览 Pull** 等价于 `/sync-pull`，只显示差异。
- **应用 Pull** 会先确认，再写快照并覆盖本地受管文件。插件依赖不会自动安装（`reconcile: none`），
  需要再执行 `dsh plugin --profile desktop install` 并重启。
- **Push** 可填写提交信息；UI 不提供强制覆盖，需要 `--force` 时请用 `/sync-push --force`。
- 卡片不可见时，先确认插件已安装并重启，再检查 `~/.dsh/cordis.patch.yml` 中的 `config.remote`；
  接口地址是 `/api/config-sync/status`。

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/sync-status` | 拉取远端并显示文件与插件差异，以及远端是否在上次同步后变化；只读 |
| `/sync-push [--force] [提交信息]` | 提交并推送当前 profile 的受管文件 |
| `/sync-pull` | 预览远端改动（dry-run），不写盘 |
| `/sync-pull apply` | 应用远端改动；先写快照，再原子写文件 |

### 模型工具

| 工具 | 说明 |
|---|---|
| `config_sync_status` | 只读状态对比，含上次同步与远端变化提示 |
| `config_sync_push` | 推送；可传 `message` 和 `force` |
| `config_sync_pull` | 默认 dry-run；`apply: true` 才写盘 |

`config_sync_pull` 默认不写盘，只有明确传 `apply=true` 才会覆盖本地文件。

### 第一次使用

1. 创建一个空的私有仓库（例如 `dsh-config`）。
2. A 机安装插件、完成配置、重启。
3. A 机执行 `/sync-push`。
4. B 机安装插件、完成配置、重启。
5. B 机依次执行 `/sync-status` → `/sync-pull` → `/sync-pull apply`。
6. 重启 DSH。

如果 B 机把同步配置写在 profile 的 `cordis.patch.yml` 里，第一次 `apply` 会用 A 机的版本覆盖它。
建议先把同步配置放到 home 级文件。

默认 `reconcile: none`，`pull apply` 只写文件，不会自动安装插件。B 机需要安装或更新插件时，请手动执行
DSH 的插件安装，或在确认仓库可信后把 `reconcile` 设为 `install`。

### 让新机器的 DSH 代你安装（可选）

如果新机器已经能运行 DSH，并且当前会话有 shell / 文件工具权限，可以直接把下面两段提示词发给它。
**这不是完全无人值守**：插件安装后必须重启 DSH，第二段要在重启后使用；安装依赖后还要再重启一次。
Git 认证（SSH key 或 HTTPS 凭据）需要提前配好，提示词里的 `YOURNAME`、`desktop` 和路径也要换成实际值。

**第一段（重启前）**

```text
请帮我在这台机器安装并配置 DSH 同步插件：
1. 执行 dsh plugin --profile desktop add github:FairmeHIT/dsh-sync。
2. 如果 ~/.dsh/cordis.patch.yml 不存在就创建；如果已存在，只把下面这段追加到数组末尾，不要覆盖：
- id: config-sync
  name: dsh-config-git-sync
  config:
    remote: 'git@github.com:YOURNAME/dsh-config.git'
    branch: main
    profile: desktop
3. 写入后读回 ~/.dsh/cordis.patch.yml，确认 remote 在 config: 下面（缩进 4 个空格），而不是直接写在 id 下面；如果文件无法写入，把完整 YAML 贴给我手动处理，不要只回复完成。
4. 不要写到 profile 的 cordis.patch.yml；完成后提醒我重启 DSH，不要尝试重启或结束当前进程。
```

**第二段（重启后）**

```text
继续完成 DSH 配置同步：
1. 调用 config_sync_status 查看差异。
2. 调用 config_sync_pull，参数 apply: true，应用远端配置。
3. 执行 dsh plugin --profile desktop install 安装 profile 依赖。
4. 完成后提醒我再次重启 DSH，不要尝试重启或结束当前进程。
```

工具不可用时，用 `/sync-status`、`/sync-pull`、`/sync-pull apply` 代替第二段的第 1–2 步。

## 冲突、强制与快照

**push 的规则**：

- 远端还没有本 profile 的 manifest：直接发布。
- 远端内容与本机完全一致：不产生空提交，只更新本地 `state.json`。
- 远端在本机上次同步后发生了变化：拒绝 push（`E_CONFLICT`），先 `/sync-pull`；确实要覆盖时用
  `/sync-push --force`（或工具参数 `force: true`）。
- 新机器第一次 push 到非空远端：同样拒绝，先 pull 采纳远端，或显式 force。

**pull 的规则**：

- `/sync-pull` 只预览，不写盘。
- `/sync-pull apply` 会用远端覆盖本地受管文件；只会删除**本机上次同步过**、且远端已不存在的受管文件。
  本机从未同步过的本地文件（例如首次 pull 时本地已有的 `cordis.patch.yml`）会保留并提示 `kept locally`。
  写之前先做快照。
- 如果本地在上次同步后也改过，输出会列出被覆盖的文件；快照仍可恢复。
- 应用过程中写入或校验失败时，本地受管文件自动回滚，并报 `E_APPLY`。

**不做自动合并**。两台机器都改过时，先 pull/force 的一方决定结果；Git 历史保留每一步，冲突需要自己判断。

## 安全边界

- **允许列表**：只处理 `package.json`、`cordis.patch.yml`、可选的 `pnpm-workspace.yaml` / `pnpm-lock.yaml`
  和 `manifest.json`。
- **路径校验**：拒绝 `..`、绝对路径、NUL 字节、其它 profile、未知文件，以及 profile 目录里允许列表之外的路径。
- **文件类型校验**：远端 manifest 和受管文件必须是普通文件；符号链接、子模块会被拒绝。
- **哈希与大小校验**：远端每个文件都按 `manifest.json` 里的 SHA-256 和大小校验，不匹配直接报错。
- **字节级写入**：从 Git blob 读取远端内容；push 时绕过 Git 过滤器和 `.gitignore` 暂存精确字节，并在提交后再次校验。
- **原子写入**：先写临时文件再重命名，避免半截配置；Windows 上对短暂的占用错误自动重试。
- **快照与回滚**：`pull apply` 前把当前受管文件写到 `$DSH_HOME/config-sync/snapshots/<profile>/`；
  应用失败时从内存中的副本恢复。状态、快照和设备文件在 POSIX 上以 0600 写入。
- **不读凭据**：`.credentials.yaml` 不在允许列表内，永远不会被打开。
- **缓存隔离**：Git 工作副本在 `$DSH_HOME/config-sync/work/<哈希>`，按远端和分支隔离，并用
  `sync.lock` 串行化，避免并发操作互相覆盖。
- **显式安装**：`reconcile` 默认 `none`。只有明确设为 `install` 时才会执行包管理器，因此远端
  `package.json` 不会在默认配置下触发安装脚本。
- **秘密扫描**：push 前对明显的内联 key / token 做启发式警告，但**不能保证**发现所有秘密；
  仓库必须保持私有，优先使用环境变量。
- **提交卫生**：提交使用配置的身份，禁用 GPG 签名和钩子，不会因为全局 Git 设置而卡住。

## 行为细节

- `push` 会镜像当前 profile 的受管文件。它只删除**本机上次同步过**、且本地已不存在的受管文件
  （例如本机主动关掉 `includeLockfile` 后的锁文件）；远端存在、但本机从未同步过的可选文件
  （例如另一台机器开启的锁文件）会被保留并在输出里标记 `preserved`。
- `push` 在内容没有变化时不会产生空提交。
- `pull apply` 会把远端受管文件写到本地；本机同步过、远端已不存在的受管文件会删除（快照里仍有副本），
  本机从未同步过的文件会保留并标记 `kept locally`。本地 `package.json` 丢失时，status 和 pull 仍可
  正常工作并把它恢复；push 会拒绝缺少 `package.json` 的 profile。
- `package.json`、锁文件或 workspace 文件变化且 `reconcile=install` 时，优先用 `pnpm install`，
  其次 `corepack pnpm install`，最后 `npm install --no-audit --no-fund`；真正的安装失败会停止并报告，
  不会再用另一个包管理器覆盖。默认 `reconcile=none`，不会自动执行安装脚本。
- `link:` / `file:` / `workspace:` 依赖无法跨机器还原，会在输出里标记为需要手动安装。
- 分支不存在时会创建新的根提交，只包含当前 profile 的受管文件，不会把其它分支历史带进来；远端分支
  被删除后再次 push 也会重建根提交，不会把旧 tip 推回去。
- 设备信息只用于 manifest 的来源提示；不需要时可以忽略，插件不会用它做授权。
- 同一个 Harness home 下的 status / push / pull 通过 `sync.lock` 串行执行；等待超过两分钟会报
  `E_BUSY`，崩溃遗留的锁会按 PID 或时间自动回收。

## 限制

- **没有三方合并**。冲突时先 pull 或显式 force，结果由最后一次操作决定。
- 不同步 sessions、skills、memories、附件、workspace 注册表、插件管理器缓存。
- host 工具 + Web UI：命令和模型工具在所有端可用；Web 端在设置页和插件页提供同一张同步卡片。
- Windows 已实测；macOS / Linux 走同样的 Node + Git 路径，CI 会覆盖测试，但真实桌面环境仍需自测。
- npm 包名与仓库名不同；npm 发布前请从 GitHub 或本地目录安装。
- 本插件自身的安装方式也会进入 `package.json`。如果一台机器用 `link:D:\...` 安装，另一台机器拉取后会得到
  同一个本地路径；跨机器请统一用 GitHub 或 npm 安装，或手动修正该依赖。
- `pnpm-workspace.yaml` 里可能有 `allowBuilds` / `minimumReleaseAgeExclude` 等机器相关设置；
  开启 `includeWorkspace` 会一起同步，请确认你接受这种影响。
- `cordis.patch.yml` 可能包含模型供应商的内联密钥；秘密扫描只是启发式，请自行确认后再 push。
- `reconcile` 默认 `none`；如果改为 `install`，远端 `package.json`（以及可选的 workspace 文件）可以选择
  要安装的包及其安装脚本，因此只应对可信仓库开启。
- 本插件按 Git 对象的精确字节校验。如果另一台机器用 `core.autocrlf=true` 提交并改写了行尾，远端会报
  `E_MANIFEST`；请用 `core.autocrlf=false` 重新提交受管文件。插件自己的缓存始终关闭行尾转换。

## 故障排查

| 现象 | 处理 |
|---|---|
| `E_CONFIG` | 没有配置 `remote`，或 `branch` 不合法；见上面的配置示例 |
| `E_PROFILE` | 自动探测到多个 profile、或探测到的目录名不是安全路径段；显式设置 `profile` |
| `E_PROFILE_MISMATCH` | 远端 manifest 的 profile 与本机配置不一致；检查 `profile` 或仓库路径 |
| `E_CONFLICT` | 远端在上次同步后变化；先 `/sync-pull`，确认后再 `/sync-push --force` |
| `E_AUTH` | push 无法认证或找不到仓库；检查 remote URL、SSH key 或 HTTPS 凭据 |
| `E_BUSY` | 另一个同步操作持有 `sync.lock`；等它结束，或确认进程已退出后删除锁文件 |
| `E_PUSH_REJECTED` | 远端在 fetch 和 push 之间又前进了；重新 `/sync-status`，pull 后再 push |
| `E_MANIFEST` | 远端 manifest 损坏、版本不支持、文件缺失或哈希/大小不匹配 |
| `E_PATH` | 仓库里出现了允许列表之外或类型不安全的路径；插件拒绝处理 |
| `E_REMOTE_EMPTY` | 远端还没有本 profile 的 manifest；先在有配置的机器上 push |
| `E_APPLY` | pull 写入或校验失败；本地受管文件已回滚，检查磁盘空间/权限后重试 |
| `E_GIT` / `E_CANCELLED` | Git 执行失败或被取消；检查 Git 安装、网络、认证和日志 |
| Git 认证失败 | 配置 SSH key 或预先缓存 HTTPS 凭据；插件不会弹出登录框 |
| pull 后插件没变化 | 重启 DSH；`cordis.patch.yml` 只在启动时组合 |

`E_CONFIG` 表示插件已经加载，只是配置里没有 `remote`；插件没装时 `config_sync_status` 工具根本不会出现。
检查 `~/.dsh/cordis.patch.yml` 是否是顶层数组，且 `remote` 在 `config:` 下面：

```yaml
- id: config-sync
  name: dsh-config-git-sync
  config:
    remote: 'git@github.com:YOURNAME/dsh-config.git'
    branch: main
    profile: desktop
```

如果 `remote` 和 `id` 对齐，或配置写进了 profile 的 `cordis.patch.yml`，都会读不到；后者还会被 pull 覆盖。
改完彻底退出并重启 DSH。

## 开发

```sh
npm install
npm test              # 单元测试 + Git 端到端测试
npm run test:e2e      # 只跑端到端
npm run pack:check    # 检查 npm 打包内容
```

测试使用 `node:test`，全部在临时目录里创建 bare 仓库和假 DSH home，不访问网络、不改真实 `~/.dsh`。
CI 在 Ubuntu / Windows / macOS 的 Node 22 和 24 上运行。

```
index.js             插件入口：3 个工具 + 3 个斜杠命令
src/config.js        Schemastery 配置、branch 校验、DSH_HOME 解析
src/paths.js         profile 探测、设备 ID、原子写、哈希、DSH 版本
src/state.js         每台机器的上次同步状态
src/lock.js          跨进程同步锁
src/text.js          远端文本消毒与列表摘要
src/manifest.js      清单构建/解析、diff、路径校验、可选文件
src/git.js           Git 封装：对象读取、树校验、精确暂存、提交与推送
src/sync.js          status / push / pull 编排、冲突检测、快照、回滚、依赖安装
src/secrets.js       内联凭据启发式扫描
locale/              插件管理器显示元数据
docs/                详情页文档与预览图
test/                单元测试 + Git 端到端测试
```

本地加载验证：

```sh
dsh plugin --profile scratch add D:\path\to\dsh-sync
dsh --profile scratch --dump-config
```

## License

MIT。见 [LICENSE](LICENSE)。
