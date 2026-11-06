# 远程文件（内核能力）设计与实现

> 状态：已实现（WebDAV / SMB / 百度网盘）· 2026-11-05 从内置插件改建为内核能力

## 1. 定位

远程文档是产品内核的一部分，**不是插件**：知识库的边界不止于本地磁盘，用户需要直接浏览、读取、编辑、写回
**WebDAV / SMB / 百度网盘** 上的文档，并做基础目录管理（新建目录、重命名、删除）。

因此它没有启停开关、不在插件工作区里出现、也不占用插件贡献点契约——它就是文件管理里的一个来源。

## 2. 形态与接线

- 视图：`frontend/src/components/RemoteFilesPanel.tsx`，挂在文件管理的「远程」来源下
- 入口：侧栏「文件管理 → 来源」的 `文件 / 远程文件` 两个 chip（`filesUi.source`）
- 启动路径：`backend/src/index.ts` 直接注册 `app.route("/api/remote-files", remoteFilesRouter)`，无插件门控
- 本地 ↔ 远程联动：文件列表行「保存到远程」、远程文本「导入为笔记」「转本地附件」

## 3. 架构

```
前端 RemoteFilesPanel（文件管理 · 远程来源）
   │  /api/remote-files/*（JWT，按 X-User-Id 隔离）
后端 routes/remote-files.ts
   │  源配置 CRUD（KV system_settings `remote_files_sources:<userId>`，凭据 AES-256-GCM 加密）
   ├─ services/remote-files/webdav.ts   PROPFIND/GET/PUT/MKCOL/DELETE/MOVE
   ├─ services/remote-files/baidu.ts    百度网盘开放平台 REST
   └─ services/remote-files/smb.ts      smb3-client（SMB 2.1 ~ 3.1.1，共享枚举 + 文件读写同一套栈）
```

- 提供方接口：`list / read / write / mkdir / remove / rename`，路径一律为「源内相对路径」（根目录 `""`），
  `normalizeRemotePath` 统一拒绝 `..` 越界
- 凭据：`credentials.ts`（scrypt(JWT_SECRET, "nowen-remote-files-v1") + AES-256-GCM，同 backup-webdav 模式）；
  接口下发只有 `hasPassword` 布尔，永无明文
- 只读代理文本：`read/write` 仅允许文本类扩展名（md/txt/json/html/代码等，`isProbablyTextFile`）

## 4. 与宿主视图的集成

远程视图与本地附件视图**并存切换**（增强而非替换），经侧栏「来源」驱动 `filesUi.source`：

- **导入为笔记**：远程文本文件 → markdownToTiptapJSON → 新建本地笔记（纯前端组合）
- **转本地附件**：`POST /api/files/upload-from-remote`——provider.readBinary 拉取后复用
  /upload 存储管线（holder note + hash 去重 + 对象存储 + 媒体分析）
- **附件另存到远程**：文件管理列表行 Cloud 按钮 → `POST /api/remote-files/sources/:id/save-attachment`
  （readAttachmentObject → provider.writeBinary）

历史说明：该功能曾以 `remote-files` 内置插件形态接入（`BUILTIN_PLUGINS` 注册表 + embedded 标记 +
localStorage 启停）。0.2.0 起改为内核能力，注册表条目、启停开关与 `embedded` 概念一并移除。

## 5. 各提供方边界

| 提供方 | 能力 | 已知限制 |
| --- | --- | --- |
| WebDAV | 全功能（列/读/写/建目录/删/改名） | 目录删除依赖服务器 Depth: infinity；XML 命名空间无关解析已适配常见 NAS |
| 百度网盘 | 列/读/写（≤4MB 单发，>4MB precreate→分片→create）/建目录/删/改名 | access_token 手动粘贴（开放平台应用授权）；有限流 |
| SMB | 全功能（smb3-client，dialect 协商 2.1 / 3.0 / 3.0.2 / 3.1.1，支持 SMB3 signing 与传输加密） | 目录条目单次上限 200；真实 NAS 兼容性待实测 |

SMB 三形态通吃（桌面 Electron / NAS Docker / 云服务器 Linux）：纯用户态协议实现，不依赖 OS 挂载。
源配置界面只需填**主机**（IP/主机名）+ 凭据，点「获取共享」由 `POST /api/remote-files/smb/shares`
（smb3-client 的 DCE/RPC `srvsvc.NetrShareEnum`）自动列出磁盘共享，下拉选择即可；列表不落库，可随时重新获取。
保存时仍拼成 `\\host\share` 存入 `baseUrl`，因此既有源、链接映射与 MCP 工具契约不变。
编辑已有源时会把地址拆回主机与共享名回填。支持域/工作组字段。

文件读写同样走 `smb3-client`（`services/remote-files/smb.ts`）：路径第一段是共享名、
其余为共享内路径，根目录用共享名而非空路径（旧 `@marsaud/smb2` 对空根目录发 CREATE 会被
部分 NAS 以 `STATUS_INVALID_PARAMETER` 拒绝，该依赖已移除）。`signing` / `encryption` 均为
`if-offered`，NAS 要求加密时自动启用，不再有「不支持 SMB3 传输加密」的限制。

## 6. 笔记级同步

- 「导入为笔记」自动建立链接映射（KV `remote_note_links:<userId>`：
  sourceId + remotePath ↔ noteId + 双侧基线 hash）
- 文件行对已链接文件显示「已链接」标记与对比入口（GitCompare）
- 对比弹层三态：远程已修改 / 笔记已修改 / 双方修改（冲突选方向）/ 一致
  ——对比基准为上次同步时双侧内容哈希（远程原文 hash + 笔记 normalizeToMarkdown 后 hash，
  规避 round-trip 损耗误报）
- 同步动作：远程 → 笔记（markdownToTiptapJSON 覆盖笔记内容）、
  笔记 → 远程（normalizeToMarkdown 写回远程）；同步后双侧基线刷新
- 支持解除链接映射

## 7. 待完善

- 百度网盘 OAuth 授权流（替代手动粘贴 token；NAS/无头部署建议设备授权流）
- 远程 ↔ 本地双向同步（对比 mtime/hash，冲突提示）
- 源级连接健康检查与缓存刷新
- 只读类型（PDF / 图片等非文本）的在线预览

## 8. 验证记录

- 2026-10-19：后端 remote-files-webdav 11/11、remote-files-baidu 8/8、remote-files-smb 7/7（全部 mock 不触网）
- 2026-11-05（去插件化）：`tsc` 前后端均 0 error；插件工作区内置插件数由 3 降为 2；
  侧栏「远程文件」chip 与文件管理远程视图不再受启停开关控制
- 未验证（待用户实测）：真实 WebDAV/NAS 连通、百度 access_token 实际读写（含 >4MB 分片）、SMB 真机连接
