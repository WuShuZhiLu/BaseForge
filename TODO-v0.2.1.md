# BaseForge v0.2.1 遗留 TODO（供后续 agent 处理）

> 上下文：v0.2.1 已在 `fix/v0.2.1` 分支修复交接文档 `.tmp/v0.2.1-issues-handoff.md` 所列问题（3.1–3.5、3.8），门禁全绿（tsc / 后端全量 267、前端 vitest 2683 / electron dataDir），已分组提交，**未 push、未打 tag**。该分支待用户审查后由用户合并进受保护的 `develop`。
> 本文件记录尚未处理的遗留项。交接文档的硬约束继续适用：不要 push/打 tag/动远端、`docs/` 不改、保持 nowen 读兼容、最小改动。

---

## 1.【已修复｜待复核确认】插件 activate 缺 nowen 宿主别名

- **位置**：`backend/src/plugins/runner-child.mjs:65`
- **现象**：`activate({ baseforge })` 未像 action 调用那样注入 `nowen` 别名；旧（nowen 时代）插件在 `activate` 里解构 `({ nowen })` 会得到 `undefined`。
- **状态**：已在 `d49120bf` 修复（activate 注入同时提供 nowen 别名）。后续 agent 复跑插件相关单测确认即可。

## 2.【已修复｜待复核确认】旧库名 IndexedDB 兜底残留空库

- **位置**：`frontend/src/lib/voiceMemoDraftStore.ts:36`
- **现象**：不支持 `indexedDB.databases()` 的浏览器上，兜底 `openDB(旧库名)` 会创建一个空的旧名库（无 drafts store，getAll 抛错被 catch 跳过）。无数据影响，仅残留空库。
- **状态**：已在 `d49120bf` 修复（兜底改为只读探测，不再创建空库）。后续 agent 复跑草稿相关测试确认即可。

## 3.【需用户配合】Docker 端到端验证

- 旧库（含 `__nowen_root_documents__` 前缀、旧触发器、旧盐凭据）在容器内升级到 v0.2.1 的实测；
- nowen 系统备份恢复实测（v142 迁移 + 触发器重建 + 附件审计）。
- 本机无 docker CLI，需在 NAS 上验证。失败时看 `docker logs` 里 `cause` 字段（日志修复已包含在本分支）。

## 4.【需用户配合】发布流程

1. 审查 `git log main..fix/v0.2.1` 后，由用户合并 `fix/v0.2.1` 进受保护的 `develop`；
2. 用 `workflow_dispatch` + `signpath_test` 验证 SignPath 签名（@v3 connector 修复已包含）；
3. 确认仓库变量齐全：`SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG`、`SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG`、`SIGNPATH_SIGNING_POLICY_SLUG`；
4. 推 tag `v0.2.1`。
- Release note 建议明确：0.1.x 用户直接升级到 0.2.1；0.2.0 不要用于从 nowen 迁移。

## 5.【决策已定，仅记录】

- 3.6（Electron appId 改名）：用户决策不处理——0.1 只有 Docker 镜像、无客户端，升级链路断裂问题不存在。
- 3.7（插件 SDK 包名）：不在本次范围；后续如要支持旧插件源码，可考虑发布空的 `@baseforge/plugin-sdk` 兼容入口 + SDK 迁移指南。
- `GITEA_DISPATCH_TOKEN` 未配置：dispatch-gitea job 会失败（不阻塞 GitHub Release）。
- Gitea Actions `npm ci` 静默退出（act_runner 拉镜像失败）：历史遗留，用户已要求暂停，CI 走 GitHub。
