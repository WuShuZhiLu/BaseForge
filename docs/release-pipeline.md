# 发布链路设计（BaseForge）

> 目标：一次打 tag，五类产物（Windows / macOS / iOS / Linux / Docker+NAS）各自在能跑的平台上构建，
> 最终统一出现在 **GitHub（主仓，权威发布点）** 与 **Gitea / Gitee（镜像与分发端）** 的同一个 Release 下。
>
> ⛔ **方向铁律：GitHub 是唯一主仓**，Gitea / Gitee 只做单向镜像与分发。
> 原因：Gitea 的 push mirror 是**单向强制覆盖**。若以 Gitea 为主仓，GitHub 侧只是被覆盖的镜像，
> 外部在 GitHub 提的 issue / PR 就会失去可工作的分支基础（分支被覆盖、review 与合并失去意义）。
> 因此协作（issue / PR / review / 打 tag）一律以 GitHub 为准。

## 1. 为什么必须分平台

| 产物 | 需要的能力 | 只能在 |
|---|---|---|
| Windows 安装包（含签名） | Windows 进程 + SignPath/codesign | GitHub 托管 `windows-latest` |
| macOS 安装包（含公证） | macOS + Xcode + 公证凭据 | GitHub 托管 `macos-*` |
| iOS（TestFlight） | macOS + Xcode | GitHub 托管 `macos-*` |
| Linux AppImage/deb | Linux | GitHub 托管 `ubuntu-latest`（`release.yml` 矩阵内一并构建）；另有 `linux-desktop-native-ci.yml` 做可移植性校验 |
| Docker 多架构镜像 | Linux + Docker + buildx | Gitea act_runner（`docker-image.yml`）；NAS 包（fpk、upk）暂无 CI |

关键约束：Gitea 的 act_runner 是「Linux 主机 + Docker 容器」模型，**无法执行 Windows/macOS 构建**
（Docker 跑不了 Windows 容器与 macOS）。GitHub 能提供这几类托管 runner，所以桌面端与 iOS 必须在 GitHub 构建。
Linux 与 Docker 两边都能跑，目前 **Linux 桌面产物走 GitHub、Docker 镜像走 Gitea**，以各自依赖的凭据位置为准。

## 2. 代码与 tag 流向

```
开发者 push/tag
      │
      ▼
GitHub（主仓，唯一真相；issue / PR / review 都在这里）
      │  仓库镜像（托管平台侧配置，不在本仓库 workflow 内）
      ├──────────────► Gitea（镜像仓：构建 Docker、收发布资产、做发布门禁）
      └──────────────► Gitee（镜像仓：只做分发）
```

- 方向**只有 GitHub → Gitea / Gitee**，任何反向合并都不存在；
- Gitea 的 push mirror 是单向强制覆盖，**绝不可反过来把 Gitea 当主仓**（会覆盖 GitHub 上的提交与分支）；
- tag 会随镜像同步，Gitea 侧收到 `push tags: v*` 后只跑 Docker 构建；Release 与资产由第 6 节的同步流程创建。

## 3. 构建与发布职责

| 平台 | workflow | 触发 | 产出 |
|---|---|---|---|
| GitHub | `release.yml`（矩阵 win/mac/linux） | tag `v*.*.*` / 手动 | 建 draft Release（正文由 `build-release-notes.mjs` 合成）→ 构建 → `--publish never` 后由 `publish` 生成校验和、重生成正文并**在 GitHub 转正式** |
| GitHub | `ios-release.yml` | tag / 手动 | TestFlight 上传（不产出 Release 资产） |
| GitHub | `ci-gate.yml` | PR、`main`、`develop`、`release/**`、手动 | 日常门禁：backend/frontend 类型检查 + 全量测试，外加发布脚本契约测试（不产出资产） |
| GitHub | `linux-desktop-native-ci.yml` | tag / 手动 | Linux 原生可移植性校验（不产出资产） |
| Gitea | `docker-image.yml` | tag `v*` / 手动（`latest_only` 补救） | Docker 多架构镜像；tag 触发**同时推 `vX.Y.Z` 与 `latest`** |
| Gitea | `sync-release.yml` | GitHub 发布后 dispatch / 手动 | 拉 GitHub 资产 → 校验 → Gitea 转正式 → 最后同步 Gitee |
| GitHub | `release.yml` 的 `build-mcp` | tag `v*.*.*` | 构建 MCP 单文件 `baseforge-mcp.mjs`，随 Release 附件分发 |

### 3.1 0.2.0 产物矩阵

一次 tag 产出下列资产，全部落在同一个 GitHub Release 下：

| 平台 | Full（含本地后端/数据库） | Lite（只连远程，无本地库） |
|---|---|---|
| Windows | `BaseForge-<v>-setup.exe`、`-portable.exe`（SignPath 签名） | `BaseForge-<v>-lite-setup.exe`、`-lite-portable.exe`（同一套签名） |
| macOS | `BaseForge-<v>-x64/-arm64.dmg`、`.zip`（公证） | `BaseForge-<v>-lite-x64/-arm64.dmg`、`.zip` |
| Linux | `BaseForge-<v>-x64.AppImage`、`.deb` | `BaseForge-<v>-lite.AppImage`、`-lite.deb` |
| 更新元数据 | `latest.yml`、`latest-mac.yml`、`latest-linux.yml` | `latest-lite*.yml`（独立 channel） |
| 校验和 | `SHA256SUMS.txt`（publish 阶段对全部资产生成） | — |
| MCP | `baseforge-mcp.mjs` 单文件（Release 附件，本机 Node 20+ 直接用） | — |
| Docker | 由 Gitea `docker-image.yml` 构建推送，tag 阶段同时给 `vX.Y.Z` 与 `latest` | — |

Lite 的产物名统一是 `BaseForge-<v>-lite-*`（`-lite` 在版本号之后），来自
`electron/builder.lite.base.config.js` 的 `artifactName`；`assert-release-matrix.mjs`
按同一命名断言，两边不一致会让 publish 直接失败。

`publish` 在转正式前会跑两道校验：`scripts/assert-release-matrix.mjs`（六套产物齐全 +
元数据没有 full/Lite 互相污染，专门防 Linux 的 `latest-linux.yml` 被 Lite 覆盖）与
`scripts/verify-release-update-assets.mjs local`（元数据版本与引用资产一致）。

Lite 与 Full 用不同 `appId`（`com.nowen.note` / `com.nowen.note.lite`）与不同更新 channel，
两者可同时安装、互不覆盖。mac 的 Lite 不依赖原生模块，两个架构在同一次 electron-builder
调用里产出，产物名必须带 `${arch}`，否则后一次会覆盖前一次。

### 3.2 Release 正文

正文由 `scripts/build-release-notes.mjs` 生成，不手写、也不用 `--generate-notes`
（后者只会列出 PR，和手写分组口径对不上，且没有下载入口）。

自上而下的结构：

1. **英文概述** — `CHANGELOG.en.md` 该版本段落的第一段；
2. **中文概述** — `CHANGELOG.md` 同段落第一段，以引用块呈现；
3. prerelease 提示（tag 含 `-` 时自动加）；
4. `## Download` — 按 `release-assets/` 里的**真实文件**生成，Full / Lite 两列，另附 MCP 单文件与 Docker；
5. `## What's changed` — 英文分组（Added / Fixed / Improved / …）；
6. **中文更新日志** — 折进 `<details>`，占位不占首屏；
7. `## Notes` — 校验和、CHANGELOG 链接、源码 tag。

英文在前的理由：GitHub 是主仓，外部协作者默认看到英文；中文完整内容折叠保留。
条目里的短 hash 与 `#123` 会被转成指向 GitHub 主仓的可点链接，正文不再出现裸 hash。

生成分两阶段：

- `prepare-release` 只生成**不含下载表**的基础版（此时产物还没构建），让 draft 一出现就有可读正文；
- `publish` 在资产齐全后带 `--assets release-assets` **重新生成**并作为 `body_path` 上传，
  因此下载表里的文件名与链接一定存在，`artifactName` 改了也不会指向 404。

Gitea / Gitee 复用 GitHub Release 的 `body`，三端发布说明天然一致；表内链接指向 GitHub 是有意为之
——GitHub 是主仓，Gitea / Gitee 只做镜像与分发。

> 发版前请把版本段落的第一段改成正式概述。脚本检测到「开发中 / in development」会在 CI 日志里
> 打印警告，但不会中断构建。

> 「平台」指**实际执行 runner 的站点**，不是文件位置。`sync-release.yml` 放在
> `.gitea/workflows/`，由 GitHub 发布后 dispatch 触发、在 Gitea 的 runner 上执行——因为读 GitHub
> 与写 Gitea/Gitee 的凭据都只放在 Gitea Secrets。GitHub 只读 `.github/workflows/`，不会执行它。
>
> ⛔ **Gitea 侧必须把 `[actions] WORKFLOW_DIRS` 收窄成 `.gitea/workflows`。**
> Gitea 默认**同时**读取 `.gitea/workflows` 与 `.github/workflows`（官方文档：
> `WORKFLOW_DIRS` 默认为这两个目录），不收窄就会把 GitHub 专用的
> `release.yml` / `ios-release.yml` / `linux-desktop-native-ci.yml` / `ci-gate.yml`
> 在 Gitea 上再跑一遍：Windows / macOS 任务因没有对应 runner 永久等待，Linux 任务白耗 40+ 分钟。
> 配置后 `.github/workflows/` 在 Gitea 侧完全不参与，两边才真正按目录隔离。
>
> ```ini
> # app.ini
> [actions]
> WORKFLOW_DIRS = .gitea/workflows
> ```

## 4. 资产同步（`scripts/sync-release-assets.mjs`）

```
node scripts/sync-release-assets.mjs --targets gitea,gitee            # tag 自动推断
node scripts/sync-release-assets.mjs --tag <TAG> --dry-run            # 指定 tag 演练
```

**版本不写死在脚本里**：tag 的解析顺序是 `--tag` 参数 → 环境变量 `RELEASE_TAG` / `GITHUB_REF_NAME`
→ `git describe --tags --abbrev=0` → 根 `package.json` 的 `version`。发版只打 tag，不改脚本。

行为：
1. 调 GitHub API 取该 tag 的 Release 与资产列表（私有仓走 API 下载，不用浏览器直链）；
2. 目标端按 tag 查 Release：**存在则复用，不存在则创建草稿**（prerelease 由 tag 是否含 `-` 决定），
   正文沿用 GitHub Release 的正文——而 GitHub 的正文由 `build-release-notes.mjs` 从
   `CHANGELOG.md` / `CHANGELOG.en.md` 的对应版本段落合成（见 §3.2），
   所以 GitHub / Gitea / Gitee 三端发布说明天然一致；
3. 逐个资产上传，按「文件名 + 大小」判定，**已存在跳过**；
4. 传完且指定 `--publish` 时，先核对资产齐全，再把 Gitea Release `draft=false`；
5. Gitee 没有草稿语义，放在 `--targets gitea,gitee` 的最后，等 Gitea 门禁通过后再公开；
6. Gitee 单附件 >100MB 直接报错并列出文件名，不做静默截断；
7. 任一目标失败 → 退出码 1，可原样重跑（幂等）。

## 4.1 凭据规则（硬性）

- 所有 token **只存在于仓库 Secrets**，脚本与 workflow 里只有变量名，没有明文；
- GitHub 侧的 `GITHUB_TOKEN` 只用于读 Release（最小权限）；
- 不要在 workflow 里开 `bash -x`/`set -x`，否则 `Authorization` 头会进日志；
- 脚本自身不打印任何 token、URL 查询串或请求头。

## 5. 需要的 Secrets / Variables

**GitHub 仓库**（构建侧）
| 名称 | 类型 | 用途 |
|---|---|---|
| `SIGNPATH_*` | Secret | Windows 签名（沿用现有） |
| `APPLE_*` | Secret | macOS 公证 / iOS 上传 |
| `GITEA_DISPATCH_TOKEN` | Secret | 仅够触发 Gitea workflow（不要复用 Gitea/Gitee 写 token） |
| `GITEA_URL` | Variable | Gitea 站点根地址 |
| `GITEA_REPO` | Variable | Gitea 镜像仓 `owner/repo` |
| `GITEA_DEFAULT_BRANCH` | Variable | 可选，默认 `main` |
| `DOCKER_IMAGE` | Variable | 可选，如 `docker.betheone.cc.cd/baseforge`；设置后 Release 正文的下载表会多一行 `docker pull`，留空则不显示 |

**Gitea 仓库**（同步侧，`sync-release.yml`）
| 名称 | 类型 | 用途 |
|---|---|---|
| `GH_MIRROR_TOKEN` | Secret | 读 GitHub Release（只读 repo 权限即可） |
| `RELEASE_SYNC_TOKEN` | Secret | 写 Gitea Release（本仓 repo 写权限） |
| `GITEE_TOKEN` | Secret | 写 Gitee Release |
| `GH_MIRROR_REPO` | Variable | GitHub 主仓 `owner/repo`（资产来源） |
| `GITEE_REPO` | Variable | Gitee 镜像仓 `owner/repo` |

**Gitea 仓库**（镜像推送侧，`docker-image.yml`）
| 名称 | 类型 | 用途 |
|---|---|---|
| `IMAGE_REPOSITORIES` | Variable | 镜像仓库列表，逗号分隔，列表里每个仓库都会推送 |
| `REGISTRY_USERS` | Variable | 用户名列表，逗号分隔，按序号与仓库一一对应 |
| `REGISTRY_TOKENS` | Secret | 密码 / token 列表，逗号分隔，同上 |
| `IMAGE_PUSH_REQUIRE_ALL` | Variable | 可选，默认 `true`：任一仓库失败即让 job 失败 |

免登录的仓库，用户名与 token 两项都写 `anon`（缺项或留空也按 `anon` 处理）：

```bash
IMAGE_REPOSITORIES = wushuzhilu/baseforge,http://docker-registry:5000/baseforge
REGISTRY_USERS     = wushuzhilu,anon
REGISTRY_TOKENS    = dckr_pat_xxx,anon
```

内网 HTTP registry 需先在宿主 daemon 侧做好两件事：`daemon.json` 加
`"insecure-registries": ["docker-registry:5000"]` 并重启 docker；同时确保 daemon 所在宿主能解析
该主机名（compose 服务名在宿主上通常解析不到，改用局域网 IP 更稳）。

## 6. 一次发版的完整操作顺序

### 6.0 分支模型

```
develop ──► feat/*       开 PR 回 develop，ci-gate 跑全量测试
   │
   └──────► release/*    版本号与 CHANGELOG 在这里定稿，push 即跑 ci-gate
                │  测试通过后合入 main
                ▼
              main       合入后在 main 上打 tag → 推 GitHub → 触发 release.yml
```

- `ci-gate` 的触发：任意 PR，以及 `main` / `develop` / `release/**` 的 push；
- **tag 只在 main 上打，且在合入 main 之后**：`sync-release.yml` 必须已存在于 Gitea 的默认分支，
  GitHub 的 dispatch 才找得到它；
- 打 tag 前必须完成两件事，否则 `version-guard` 与 `docker-image.yml` 会直接拦下：
  `package.json` 的 `version` 改成目标版本、`CHANGELOG.md` 把 `## Unreleased` 改名为 `## vX.Y.Z - 日期`。

1. 在本仓确认版本号：根 `package.json` 的 `version` 与要打的 tag 完全一致（`release.yml` 的 `version-guard` 会校验）；
   同时确认 `CHANGELOG.md` 已有 `## vX.Y.Z - 日期` 段落（`docker-image.yml` 会拿它和 tag 比对，缺失或不一致直接失败）；
2. 在 **main** 上打 tag 并推 GitHub：`git tag <TAG> && git push <github-remote> <TAG>`
   （`<TAG>` 形如 `v1.2.3`；**绝不能推 `origin`**——本地 `origin` 当前指向 Gitea，
   推过去会让 Gitea 的 push mirror 反向覆盖 GitHub 主仓）；
3. 仓库镜像把 tag 带到 Gitea / Gitee（Gitea 侧随即跑 `docker-image.yml`，同时推 `vX.Y.Z` 与 `latest`；Gitea 的 Release 要等第 6 步同步才建，不在 tag 时抢先占位）；
4. GitHub 自动跑 `release.yml`：
   - `version-guard` 校验 tag ↔ `package.json` 版本，并确认 `CHANGELOG.md` 已有 `## vX.Y.Z` 段落；
   - `prepare-release` 先建 **draft** GitHub Release，正文由 `build-release-notes.mjs` 生成
     （英文概述 + 中文折叠；此时没有下载表，见 §3.2）；
   - 矩阵构建 win / mac / linux，**每平台同时出 Full 与 Lite**（Windows 的 Full/Lite 分别经
     SignPath `release-signing` 签名）；
   - `publish` 汇总资产 → `assert-release-matrix` 校验六套产物齐全 → `verify-release-update-assets`
     校验元数据 → 生成 `SHA256SUMS.txt` → 带真实资产**重新生成正文**（这次含下载表）
     → **在 GitHub 转正式**；
   - 并行的 `build-mcp` 打出 `baseforge-mcp.mjs` 单文件，作为 Release 附件一起发布；
5. GitHub `dispatch-gitea` 用 `GITEA_DISPATCH_TOKEN` 触发 Gitea 的 `sync-release.yml`；
6. Gitea 侧：资产同步到 Gitea Release（draft）→ 校验齐全 → Gitea 转正式；
7. 同一轮同步的最后处理 Gitee（Gitee 创建即公开，所以放在 Gitea 门禁之后）；
8. 检查 Gitea 与 Gitee 的 Release 资产齐全（脚本可重复执行补齐）。

> 手动兜底：任一步失败都可以在 Gitea 手动 dispatch `Sync Release Assets`
> （`publish=true` 时会在校验后转正），不需要重建 GitHub 产物。
>
> Docker 镜像：tag 触发时 `docker-image.yml` 直接推 `vX.Y.Z` 与 `latest`（先版本、后 latest，
> 版本推失败就不动 latest），不等桌面端发布门禁。`latest_only` 只作为手动补救入口保留。
>
> tag 只往 GitHub 推。若图省事往 Gitea 推 tag，Gitea 的 push mirror 会把 GitHub 侧覆盖，
> 发布链与外部协作都会受影响。

## 7. 已知限制与后续

- **Gitee 附件 100MB 上限**：若 Windows 安装包超过，需要分卷或改用外链分发（脚本会明确报错）；
- **Gitee 没有草稿语义**：只能保证"最后同步"，无法做到"先隐藏、后公开"；
- **GitHub 回调依赖 Gitea Actions dispatch API**：需 Gitea 版本支持
  `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`；
- **仓库镜像由托管平台侧配置**：本仓库 workflow 不含代码镜像逻辑，方向固定为 GitHub → Gitea / Gitee；
- **Linux 桌面产物在 GitHub 构建**：Gitea act_runner 也能跑，但依赖凭据与产物归集都在 GitHub 侧，暂不迁；
- **NAS 包（fpk / upk）暂无 CI**：脚本在 `scripts/fpk`、`scripts/upk`，尚未接入任何 workflow；
- **`scripts/release.sh` 是手动兜底链路**：它仍可以创建 Draft、汇总 CI 资产并转正式，
  但不要和 tag 触发的 CI 链路同时操作同一个 Release（两者都会改 Release 状态）。
