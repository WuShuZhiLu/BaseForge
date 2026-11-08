# 发布链路设计（BaseForge）

> 目标：一次打 tag，五类产物（Windows / macOS / iOS / Linux / Docker+NAS）各自在能跑的平台上构建，
> 最终统一出现在 **Gitea（主仓）** 与 **Gitee / GitHub（镜像）** 的同一个 Release 下。

## 1. 为什么必须分平台

| 产物 | 需要的能力 | 只能在 |
|---|---|---|
| Windows 安装包（含签名） | Windows 进程 + SignPath/codesign | GitHub 托管 `windows-latest` |
| macOS 安装包（含公证） | macOS + Xcode + 公证凭据 | GitHub 托管 `macos-*` |
| iOS（TestFlight） | macOS + Xcode | GitHub 托管 `macos-*` |
| Linux AppImage/deb | Linux | **Gitea act_runner（可跑）** 或 GitHub |
| Docker 多架构镜像 / NAS 包（fpk、upk） | Linux + Docker + buildx | **Gitea act_runner（可跑）** |

关键约束：Gitea 的 act_runner 是「Linux 主机 + Docker 容器」模型，**无法执行 Windows/macOS 构建**
（Docker 跑不了 Windows 容器与 macOS）。GitHub 能提供这几类托管 runner，所以桌面端与 iOS 必须在 GitHub 构建。

## 2. 代码与 tag 流向

```
开发者 push/tag
      │
      ▼
Gitea（主仓，唯一真相）
      │  push mirror（Gitea 自带，含 tag）
      ├──────────────► GitHub（镜像仓，只做构建）
      └──────────────► Gitee（镜像仓，只做分发）
```

- Gitea → GitHub/Gitee 用**推送镜像**，不做反向合并；
- tag 会随镜像同步，GitHub 侧收到 `push tags: v*.*.*` 即开始构建。

## 3. 构建与发布职责

| 平台 | workflow | 产出 |
|---|---|---|
| GitHub | `release.yml`（矩阵 win/mac） | `--publish never`，构建后由发布步骤上传到 GitHub Release |
| GitHub | `ios-release.yml` | TestFlight 上传（不产出 Release 资产） |
| Gitea | `ci-gate.yml` | 类型检查 + 全量测试（门禁，不产出资产） |
| Gitea | `linux-desktop-native-ci.yml`（tag） | Linux 桌面产物 |
| Gitea | `sync-release.yml` | 把 GitHub Release 资产搬到 Gitea + Gitee |

## 4. 资产同步（`scripts/sync-release-assets.mjs`）

```
node scripts/sync-release-assets.mjs --targets gitea,gitee            # tag 自动推断
node scripts/sync-release-assets.mjs --tag <TAG> --dry-run            # 指定 tag 演练
```

**版本不写死在脚本里**：tag 的解析顺序是 `--tag` 参数 → 环境变量 `RELEASE_TAG` / `GITHUB_REF_NAME`
→ `git describe --tags --abbrev=0` → 根 `package.json` 的 `version`。发版只打 tag，不改脚本。

行为：
1. 调 GitHub API 取该 tag 的 Release 与资产列表（私有仓走 API 下载，不用浏览器直链）；
2. 目标端按 tag 查 Release：**存在则复用，不存在则创建草稿**（prerelease 由 tag 是否含 `-` 决定）；
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
| `GITEA_REPO` | Variable | Gitea 主仓 `owner/repo` |
| `GITEA_DEFAULT_BRANCH` | Variable | 可选，默认 `main` |

**Gitea 仓库**（同步侧，`sync-release.yml`）
| 名称 | 类型 | 用途 |
|---|---|---|
| `GH_MIRROR_TOKEN` | Secret | 读 GitHub Release（只读 repo 权限即可） |
| `RELEASE_SYNC_TOKEN` | Secret | 写 Gitea Release（本仓 repo 写权限） |
| `GITEE_TOKEN` | Secret | 写 Gitee Release |
| `GH_MIRROR_REPO` | Variable | GitHub 镜像仓 `owner/repo` |
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

1. 在本仓确认版本号：根 `package.json` 的 `version` 与要打的 tag 完全一致（`release.yml` 的 `version-guard` 会校验）；
2. `git tag <TAG> && git push origin <TAG>`（推到 Gitea；`<TAG>` 形如 `v1.2.3` 或 `v1.2.3-pre1`）；
3. Gitea push mirror 把 tag 带到 GitHub/Gitee；
4. GitHub 自动跑 `release.yml`：
   - `prepare-release` 先建 **draft** GitHub Release；
   - 矩阵构建 win/mac（Linux 一并构建）；
   - `publish` 汇总「已签名 Windows + macOS + Linux」→ 校验 `latest*.yml` 等资产 → 转正式；
5. GitHub `dispatch-gitea` 用 `GITEA_DISPATCH_TOKEN` 触发 Gitea 的 `sync-release.yml`；
6. Gitea 侧：资产同步到 Gitea Release（draft）→ 校验齐全 → 转正式；随后 dispatch
   `docker-image.yml` 的 `latest_only` 模式，把 `latest` 指向本次版本；
7. 同一轮同步的最后处理 Gitee（Gitee 创建即公开，所以放在 Gitea 门禁之后）；
8. 检查 Gitea 与 Gitee 的 Release 资产齐全（脚本可重复执行补齐）。

> 手动兜底：任一步失败都可以在 Gitea 手动 dispatch `Sync Release Assets`
> （`publish=true` 时会在校验后转正），不需要重建 GitHub 产物。
>
> Docker 镜像：tag 触发只推 `vX.Y.Z`；`latest` 只在第 6 步的发布门禁后移动。

## 7. 已知限制与后续

- **Gitee 附件 100MB 上限**：若 Windows 安装包超过，需要分卷或改用外链分发（脚本会明确报错）；
- **Gitee 没有草稿语义**：只能保证"最后同步"，无法做到"先隐藏、后公开"；
- **GitHub 回调依赖 Gitea Actions dispatch API**：需 Gitea 版本支持
  `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`；
- **Linux 产物目前仍走 GitHub**：待 Gitea 侧构建链路补齐后再迁到 Gitea；
- **`scripts/release.sh` 是手动兜底链路**：它仍可以创建 Draft、汇总 CI 资产并转正式，
  但不要和 tag 触发的 CI 链路同时操作同一个 Release（两者都会改 Release 状态）。
