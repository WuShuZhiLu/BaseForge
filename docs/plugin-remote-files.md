# 远程文件管理插件（remote-files）设计与实现

> 分支：`feat/plugin-remote-files`（自 `feat/version-history-v2` 切出）· 状态：P1 已实现 · 日期：2026-10-19

## 1. 目标

以「官方内置插件」（与待办/每日记录同管线）形态提供远程文档管理：对 **WebDAV / 百度网盘（SMB 后续）** 上的文档进行 **浏览、读取、编辑、写回**，以及基础的目录管理（新建目录、重命名、删除）。

## 2. 形态与接线（与内置插件管线一致）

- 注册表：`frontend/src/plugins/builtin/registry.ts` 新增 `remote-files`（侧栏面板 + 主区 viewMode）
- 导航：`NavRailNext`PLUGIN_NAV_ITEMS 新增 Cloud 图标项（workspaceFeature: notes）
- 侧栏迷你面板：`MiniPanels.tsx` `RemoteFilesMiniPanel`（源列表 + 在主区打开）
- 主区中心：`App.tsx` viewMode `remote-files` → `components/RemoteFilesCenter.tsx`
- 停用开关：复用 `nowen-builtin-plugins-disabled`（localStorage），停用后 Rail/侧栏入口消失、数据保留

## 3. 架构

```
前端 RemoteFilesCenter
   │  /api/remote-files/*（JWT，按 X-User-Id 隔离）
后端 routes/remote-files.ts
   │  源配置 CRUD（KV system_settings `remote_files_sources:<userId>`，凭据 AES-256-GCM 加密）
   ├─ services/remote-files/webdav.ts   PROPFIND/GET/PUT/MKCOL/DELETE/MOVE
   ├─ services/remote-files/baidu.ts    百度网盘开放平台 REST（实验性）
   └─ services/remote-files/smb.ts      P1 stub（明确报错）
```

- 提供方接口：`list / read / write / mkdir / remove / rename`，路径一律为「源内相对路径」（根目录 `""`），`normalizeRemotePath` 统一拒绝 `..` 越界
- 凭据：`credentials.ts`（scrypt(JWT_SECRET, "nowen-remote-files-v1") + AES-256-GCM，同 backup-webdav 模式）；接口下发只有 `hasPassword` 布尔，永无明文
- 只读代理文本：`read/write` 仅允许文本类扩展名（md/txt/json/html/代码等，`isProbablyTextFile`）

## 4. 与宿主视图的集成（增强型插件形态）

remote-files 为 **embedded 插件**（registry 标记），不占独立 Rail 徽章：

- 文件管理顶栏「本地 / 远程」分段 Tab：远程视图与本地附件视图**并存切换**（增强而非替换）
- **导入为笔记**：远程文本文件 → markdownToTiptapJSON → 新建本地笔记（纯前端组合）
- **转本地附件**：`POST /api/files/upload-from-remote`——provider.readBinary 拉取后复用
  /upload 存储管线（holder note + hash 去重 + 对象存储 + 媒体分析）
- **附件另存到远程**：文件管理列表行 Cloud 按钮 → `POST /api/remote-files/sources/:id/save-attachment`
  （readAttachmentObject → provider.writeBinary）
- Rail 徽章自定义（独立插件）：右键徽章隐藏 / 空白右键添加徽章 / 插件组折叠 / 插件详情，
  持久化 localStorage `nowen-rail-customization`

## 5. 各提供方边界

| 提供方 | 能力 | 已知限制 |
| --- | --- | --- |
| WebDAV | 全功能（列/读/写/建目录/删/改名） | 目录删除依赖服务器 Depth: infinity；XML 命名空间无关解析已适配常见 NAS |
| 百度网盘 | 列/读/写（≤4MB 单发，>4MB precreate→分片→create）/建目录/删/改名（实验性） | access_token 手动粘贴（开放平台应用授权）；有限流 |
| SMB | 全功能（@marsaud/smb2 纯 JS 协议栈，0.18.0） | **不支持 SMB3 传输加密**（NAS 强制加密时连不上，需关闭或改用 WebDAV）；dialect 协商上限 3.0.2；目录条目单次上限 200 |

SMB 三形态通吃（桌面 Electron / NAS Docker / 云服务器 Linux）：纯用户态协议实现，不依赖 OS 挂载。地址双格式 `\hostshare` 与 `smb://host[:445]/share`；支持域/工作组字段。

## 6. 笔记级同步（已实现）

- 「导入为笔记」自动建立链接映射（KV `remote_note_links:<userId>`：
  sourceId + remotePath ↔ noteId + 双侧基线 hash）
- 文件行对已链接文件显示「已链接」标记与对比入口（GitCompare）
- 对比弹层三态：远程已修改 / 笔记已修改 / 双方修改（冲突选方向）/ 一致
  ——对比基准为上次同步时双侧内容哈希（远程原文 hash + 笔记
  normalizeToMarkdown 后 hash，规避 round-trip 损耗误报）
- 同步动作：远程 → 笔记（markdownToTiptapJSON 覆盖笔记内容）、
  笔记 → 远程（normalizeToMarkdown 写回远程）；同步后双侧基线刷新
- 支持解除链接映射

## 7. P2 剩余

- 百度网盘 OAuth 授权流（替代手动粘贴 token；NAS/无头部署建议设备授权流）
- 远程↔本地双向同步（对比 mtime/hash，冲突提示）
- 源级连接健康检查与缓存刷新

## 8. 验证记录（2026-10-19）

- 后端：remote-files-webdav 11/11、remote-files-baidu 8/8、remote-files-smb 7/7（全部 mock 不触网）；`build.bundle.mjs` 构建通过
- 前端：`tsc -b` 0 错误；全量 vitest 的 2 个失败文件（releaseI18nCoverage / androidNativeHttpBridge）为**既有失败**（基线 stash 对照一致）
- 未验证（待用户实测）：真实 WebDAV/NAS 连通、百度 access_token 实际读写（含 >4MB 分片）、SMB 真机连接
