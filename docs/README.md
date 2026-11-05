# 文档索引

本目录共 160+ 份文档，按「怎么用 / 怎么部署 / 怎么开发 / 历史与上游」四类组织。
找不到时先看这里，再全目录搜索。

## 1. 使用与功能

| 文档 | 说明 |
|---|---|
| [tree-tutorial.md](./tree-tutorial.md) | 知识库树的使用方式 |
| [editor-mode-switch.md](./editor-mode-switch.md) | 富文本 / Markdown 编辑器切换 |
| [mobile-media-experience.md](./mobile-media-experience.md) | 移动端媒体体验 |
| [android-share-import.md](./android-share-import.md) | Android 分享导入 |
| [desktop-folder-sync.md](./desktop-folder-sync.md) | 桌面端文件夹同步 |
| [note-image-export.md](./note-image-export.md) | 笔记导出图片 |
| [export.md](./export.md) | 导出能力总览 |
| [version-history-v2.md](./version-history-v2.md) | 版本历史 |
| [sync-realtime.md](./sync-realtime.md) | 实时同步 |

## 2. 部署与运维

| 文档 | 说明 |
|---|---|
| [deployment.md](./deployment.md) | Docker 部署总览 |
| [release-pipeline.md](./release-pipeline.md) | 发布链路（GitHub 构建 → 同步 Gitea/Gitee） |
| [deploy-arm64.md](./deploy-arm64.md) | ARM64 部署 |
| [object-storage.md](./object-storage.md) | S3 / R2 / MinIO 对象存储 |
| [attachments-storage.md](./attachments-storage.md) | 附件存储策略 |
| [webdav-backup.md](./webdav-backup.md) | WebDAV 备份 |
| [backup-email-smtp.md](./backup-email-smtp.md) | 邮件备份（SMTP） |
| [server-profiles-and-nas-migration.md](./server-profiles-and-nas-migration.md) | NAS 迁移与服务器配置 |
| [icp-beian-env.md](./icp-beian-env.md) | 备案环境变量 |
| [CODE_SIGNING.md](./CODE_SIGNING.md) | 代码签名（Windows / macOS） |
| [iOS-Release.md](./iOS-Release.md) | iOS 发布流程 |
| [mac-install.md](./mac-install.md) | macOS 安装说明 |
| [PRIVACY.md](./PRIVACY.md) | 隐私说明 |
| [known-issues.md](./known-issues.md) | 已知问题 |

## 3. 开发与架构

| 文档 | 说明 |
|---|---|
| [development-notes.md](./development-notes.md) | 开发笔记 |
| [repository-pilot-guide.md](./repository-pilot-guide.md) | 仓库协作约定 |
| [block-authority-and-subdocuments.md](./block-authority-and-subdocuments.md) | 块权威与子文档模型 |
| [block-patch-api.md](./block-patch-api.md) | 块级 patch API |
| [block-patch-list-hierarchy.md](./block-patch-list-hierarchy.md) | 列表层级 patch |
| [block-patch-list-structure.md](./block-patch-list-structure.md) | 列表结构 patch |
| [block-patch-empty-document.md](./block-patch-empty-document.md) | 空文档 patch |
| [rich-text-note-split-assessment.md](./rich-text-note-split-assessment.md) | 长文拆分评估 |
| [multi-device-sync-validation.md](./multi-device-sync-validation.md) | 多端同步验证 |
| [plugin-pm.md](./plugin-pm.md) | 插件：项目管理 |
| [plugin-pm-analysis.md](./plugin-pm-analysis.md) | 插件：项目管理（分析） |
| [plugin-pm-m3-design.md](./plugin-pm-m3-design.md) | 插件：项目管理（M3 设计） |
| [remote-files.md](./remote-files.md) | 远程文件（内核能力：WebDAV / SMB / 百度网盘） |
| [handover/HANDOVER-pm-and-remote-files.md](./HANDOVER-pm-and-remote-files.md) | 交接：PM 与远程文件 |

## 4. 子目录

| 目录 | 内容 |
|---|---|
| [plugins/](./plugins/) | 插件平台与贡献点说明 |
| [product/](./product/) | 产品设计与决策记录 |
| [performance/](./performance/) | 性能基线与分析 |
| [tutorials/](./tutorials/) | 用户教程（含 MCP 安装等） |
| [screenshots/](./screenshots/) | 文档截图资源 |
| [superpowers/](./superpowers/) | **上游 nowen-note 遗留文档**（保留以记录历史，不代表当前实现） |

## 约定

- 新增面向用户/运维的文档，直接放 `docs/` 根并按上面四类归位；
- 一次性分析、评估类文档（`*-assessment.md`、`plugin-pm-analysis.md`）属过程记录，不再更新；
- 上游遗留内容（`superpowers/`、`tutorials/` 中的版本声明）保持原样，改动需单独说明。
