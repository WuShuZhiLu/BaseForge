# 更新日志 / Changelog

本文档由 `scripts/generate-changelog.mjs` 从 git commit（Conventional Commits）自动生成，并在每次
`scripts/release.sh` 发版时追加新版本。手写修订同样欢迎——发布脚本只会在文件顶部的占位标记下方
追加新版本条目，已有内容不会被改写。

格式说明：

- 每个版本一个二级标题：`## vX.Y.Z - YYYY-MM-DD`
- 条目按类型分组：新增 / 修复 / 优化 / 文档 / 重构 / 其他
- Commit 以 Conventional Commits 为规范（feat / fix / perf / refactor / docs / chore / style / test / build / ci）

<!-- ADD_NEW_HERE -->

## Unreleased

Base Notes 尚未正式发布，当前为开发预览阶段（版本号 `1.0.0-preview.1`）。正式发布时，本节内容将
改为正式版本标题（如 `## v1.0.0-preview.1 - YYYY-MM-DD`）。

- 版本线自 **1.0.0** 起独立演进，不跟随上游 nowen-note 的版本号。
- 代码基线：nowen-note **v1.4.16**（fd17d980），已吸收上游 **v1.5.1** 的全部功能与框架层更新
  （同步引擎、加密文档/加密块、轻量表格、插件平台、任务中心、通知/评论/回收站、思维导图增强、
  数据管理/备份、笔记外观主题、搜索排除等）。
- 界面、交互与品牌保持 Base Notes 自有设计（1.4.16 UI 基线 + 新功能入口）。
