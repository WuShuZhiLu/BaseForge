# 远程文件（内核能力）设计与实现

> 状态：已实现（WebDAV / SMB / 百度网盘）· 2026-11-05 从内置插件改建为内核能力

## 1. 定位

远程文档是产品内核的一部分，**不是插件**：知识库的边界不止于本地磁盘，用户需要直接浏览、读取、编辑、写回
**WebDAV / SMB / 百度网盘** 上的文档，并做基础目录管理（新建目录、重命名、删除）。

因此它没有启停开关、不在插件工作区里出现、也不占用插件贡献点契约——它就是文件管理里的一个来源。

## 2. 形态与接线

- 视图：`frontend/src/components/RemoteFilesPanel.tsx`，挂在文件管理的「远程」来源下
- 入口：侧栏「文件管理 → 来源」的 `文件 / 远程文件` 两个 chip（`filesUi.source`）；
  选中远程后侧栏出现「存储 / 类型 / 排序 / 修改时间」四组（与本地视图同构），
  当前存储由 `filesUi.remoteSourceId` 驱动，侧栏与主区共用同一份状态
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
- 凭据：`credentials.ts` 用**独立密钥文件** `<dataDir>/.remote_secret_key`（32 字节随机、0600）
  + AES-256-GCM（密文格式 `v2:iv:tag:payload`）；接口下发只有 `hasPassword` / `credentialState`，永无明文
- 只读代理文本：`read/write` 仅允许文本类扩展名（md/txt/json/html/代码等，`isProbablyTextFile`）

### 3.1 凭据密钥为什么不用 JWT_SECRET

旧实现是 `scrypt(JWT_SECRET, "nowen-remote-files-v1")` 派生，有三个硬伤：

1. `JWT_SECRET` 没配时**回退到源码里写死的常量**，谁拿到代码谁都能解；
2. 备份包里有 `.jwt_secret`，等于导出备份时把解凭据的钥匙一起送出去；
3. 轮换 `JWT_SECRET` 或换机恢复后，所有远程源密码会**静默解成空串**，表现为莫名其妙的「认证失败」。

现在密钥独立落盘、**不写进备份包**：换机恢复后凭据解不开是预期行为，`sourceCredentialState()`
会把该源标成 `unreadable`，UI 在源列表与主区顶部明确提示「凭据已失效，请重新输入密码」，
而不是当匿名登录继续跑。历史 `v1:` 密文仍可解密，读到时会自动升级成 `v2:`。

## 4. 与宿主视图的集成

远程视图与本地附件视图**并存切换**（增强而非替换），经侧栏「来源」驱动 `filesUi.source`：

- **链接到知识库**（原「在知识库打开」/更早的「导入为笔记」）：选中的远程文本文件 →
  markdownToTiptapJSON → 在用户指定的知识库里建普通笔记 + 链接映射，
  可多选、可新建知识库，之后保存自动写回远程（见第 6 节）
- **转本地附件**：`POST /api/files/upload-from-remote`——provider.readBinary 拉取后复用
  /upload 存储管线（holder note + hash 去重 + 对象存储 + 媒体分析）
- **附件另存到远程**：文件管理列表行 Cloud 按钮 → `POST /api/remote-files/sources/:id/save-attachment`
  （readAttachmentObject → provider.writeBinary）

历史说明：该功能曾以 `remote-files` 内置插件形态接入（`BUILTIN_PLUGINS` 注册表 + embedded 标记 +
localStorage 启停）。0.2.0 起改为内核能力，注册表条目、启停开关与 `embedded` 概念一并移除。

## 5. 各提供方边界

| 提供方 | 能力 | 已知限制 |
| --- | --- | --- |
| WebDAV（首选） | 全功能（列/读/写/建目录/删/改名），一个源可挂多个根目录 | 目录删除先整删、服务器不支持递归删时回退逐层删 |
| SMB（局域网） | 全功能，可挂多个共享（smb3-client，dialect 协商 2.1 / 3.0 / 3.0.2 / 3.1.1，支持 signing 与传输加密） | 目录条目单次上限 200；SMB1 不再支持 |
| 百度网盘（直连，实验性） | 列/读/写（≤4MB 单发，>4MB precreate→分片→create）/建目录/删/改名 | 需要开放平台应用凭据，令牌会过期，有限流；建议改用 OpenList + WebDAV |

界面里的类型顺序按实际常见程度排：**WebDAV → SMB → 百度网盘**。

### 5.1 云盘不要逐个做适配：交给 OpenList

百度 / 夸克 / 115 / 阿里云盘 / 天翼 / 迅雷这类网盘，不要为每家写 OAuth + 分片上传（最脆弱的一块）。
[OpenList](https://github.com/OpenListTeam/OpenList)（AList 社区分叉，AGPL-3.0）支持 40+ 存储后端，
并**自带 WebDAV 服务**（`http://host:5244/dav/`）。

正确用法：用户自建 OpenList 挂载网盘 → 在本产品里配一个 **WebDAV 源**指向那个地址。
只维护一个通用协议就能覆盖全部云盘。许可说明：通过 WebDAV 协议访问用户自己部署的实例不构成派生作品，
**不要把 OpenList 打进我们的镜像**（那会触发 AGPL 传染）。源表单里已内置这段引导文案。

### 5.2 SMB：一台设备 = 一个源，共享可多选

源配置只需填**名称 + 主机（IP/主机名）+ 用户名 + 密码**（公开共享两者留空），
点一次「浏览共享」= 连通性测试 + 共享枚举（`POST /api/remote-files/smb/shares`，
smb3-client 的 DCE/RPC `srvsvc.NetrShareEnum`），然后**多选**要挂载的共享。
失败按「地址不可达 / 认证失败 / 协议不兼容」分类提示，不再只回一句原始 NT_STATUS。

数据模型：`RemoteSourceConfig` 新增 `host` + `shares: string[]`。

- **单共享**（最常见）仍落成历史形态 `baseUrl = \\host\share`、不带 `host/shares`，
  路径仍是共享内相对路径 —— 已存的「远程 ↔ 笔记」链接不会失效；
- **多共享**才启用虚拟根：根目录把各共享并列成文件夹，路径第一段是共享名
  （`media/2026/a.md`），一个设备上文件分散在几个共享时不用配好几遍。

文件读写同样走 `smb3-client`（`services/remote-files/smb.ts`）：根目录用共享名而非空路径
（旧 `@marsaud/smb2` 对空根目录发 CREATE 会被部分 NAS 以 `STATUS_INVALID_PARAMETER` 拒绝，
该依赖已移除）。`signing` / `encryption` 均为 `if-offered`，NAS 要求加密时自动启用。

**列目录性能**：SMB 大目录里逐条 `stat` 是绝对大头（实测 200 条约 350ms，`readdir` 仅约 20ms），
因为一次 `stat` = CREATE + CLOSE 两个往返。因此 `list` 支持 `fast: true`（只返回名称/类型），
前端先用快速结果把列表画出来，再后台补 `size/modifiedAt`；另外前端有按 `(源, 路径)` 的会话级
目录缓存（TTL 30s，显式刷新与增删改强制重拉），回根目录、来回切目录不再重复等 NAS。

**刷新剔除已删除共享**：虚拟根平时只回配置里的共享名（不连服务器）；`list` 带 `revalidate: true`
（界面「更多 → 刷新」）时才对每个共享做存在性探测，NAS 上已删除/改名的共享不再显示，并**同步从
源配置里剔除**（只在确有剔除且还剩至少一个时写，避免把临时故障写成永久删除）。
只剔除「共享不存在」类错误（`STATUS_BAD_NETWORK_NAME` / 对象名不存在），主机离线、权限不足等
仍保留显示。管理存储的共享列表也会把「已保存但远端列举不到」的共享显示出来（标注「远端已不存在」），
可手动取消，不会出现「看不见也取消不掉」的条目。

### 5.3 WebDAV：一个源可挂多个根目录

与 SMB 多共享对齐：填完地址与凭据点「连接」，逐层浏览后**勾选**要挂载的目录（可多选），
也可在「高级」里手动添加路径。

数据模型：`RemoteSourceConfig` 新增 `rootPaths: { name, path }[]`。`path` 是相对服务器地址的
绝对路径（`/` 表示服务器根），`name` 是源内路径第一段的别名（重名由后端加 `-2` 后缀）。

- 有 `rootPaths` 即多根：根目录把各别名并列成文件夹，路径第一段是别名（`docs/2026/a.md`）；
  保存时 `rootPath` 置空；
- 无 `rootPaths` 沿用单根 `rootPath` —— 历史数据与已存的「远程 ↔ 笔记」链接路径不变；
- 源级「测试连接」在多根 / 多共享时探第一个根，避免只列虚拟根造成的假成功。

客户端用 `webdav` 5.x（`createClient`）：`authType: Auto` = 先 Basic，遇到 Digest 挑战自动降级重试，
不再手写 PROPFIND XML 解析；目录删除先整删，409/405 时回退逐层删。

刷新同理：`revalidate` 时对每个挂载根发一次 PROPFIND，404 的根（远端已删除/改名）从虚拟根剔除
并同步从配置里清掉，其它错误（401/403、超时）仍保留。

## 6. 远程文档直接编辑（投影式）

产品要求：远程设备上的文档**不导入副本**，直接在知识库里用自家编辑器读写。

- **链接到知识库**（入口：文件行图标 / 批量栏按钮，可多选一次链接多条）：
  弹出目标选择器，从当前空间的知识库列表里挑一个，或就地新建一个知识库再链接进去。
  确认后逐个读出远程内容 → `markdownToTiptapJSON` → 在**指定的那个知识库**里建普通笔记
  （正文是 Tiptap JSON 缓存），并写入链接映射（KV `remote_note_links:<userId>`：
  sourceId + remotePath ↔ noteId + 双侧基线 hash）。
  - 不传 `notebookId` 会变成不属于任何知识库的游离笔记（知识树里看不到），所以必须显式传；
    后端会连带继承 `workspaceId` 并做目标库的写权限校验
  - 已链接且就在目标库：跳过；已链接但在别的库：**移动到目标库**（不重建笔记，同步基线保留）
  - 目标库已有同名标题时加 `(2)(3)` 后缀（远程目录里 `README.md` 这类同名文件很常见）
  - 非文本文件（图片、压缩包等）不出现在待链接集合里，多选时跳过并提示
  - 记住上次用过的目标知识库，下次弹窗默认选中；单项链接完成直接进笔记，批量完成留在列表给汇总
  - 已链接的文件图标变成蓝色，再点直接跳到那条笔记，不重复创建
- **保存即写回**：编辑器保存成功后（显式保存入口）经 `lib/remoteNoteSync.ts` 防抖 1.2s
  合并，把 `normalizeToMarkdown(正文)` 写回远程并刷新双侧基线
- **打开即对齐**：打开笔记时比较远程原文 hash 与基线——
  - 远程没变：什么都不做；
  - 远程变了、本地没改：自动拉取（覆盖安全）；
  - 两边都改了：弹窗让用户选「用远程覆盖 / 保留本地」（保留本地会立即推送）
- **失败不静默**：写不进去时 toast 明确提示「改动只保存在本地」（同一笔记每会话一次）；
  远程离线时打开不做任何打扰，本地照常可编辑
- **来源标记**：知识库的笔记列表卡片与知识树节点行上有一个蓝色云图标，
  提示这条文档的正文来自远程文件、保存会写回远程
- 边界：只有文本类文件（md/txt/json/html/代码等）可进编辑器；PDF / 图片等只读类型不进编辑器；
  删除笔记只解除本地投影，不删远程文件

## 7. 待完善

- ~~远程目录作为知识库子树~~（已放弃：改为「多选远程文档链接到指定知识库 / 新建知识库后链接」，
  逐文件投影比整目录挂载更符合知识库是产品单位的设计）
- 远程文件在笔记里的图片引用（远程相对路径图片暂不代理）
- 百度网盘 OAuth 授权流（替代手动粘贴 token；NAS/无头部署建议设备授权流）
- 远程源级缓存与目录列表 mtime 增量刷新
- 只读类型（PDF / 图片等非文本）的在线预览

## 8. 验证记录

- 2026-10-19：后端 remote-files-webdav 11/11、remote-files-baidu 8/8、remote-files-smb 7/7（全部 mock 不触网）
- 2026-11-05（去插件化）：`tsc` 前后端均 0 error；插件工作区内置插件数由 3 降为 2
- 2026-11-06（本批）：SMB 多共享虚拟根 4 项、凭据独立密钥 5 项新增回归，`remote-files-smb` 共 14/14；
  前后端 `tsc` 0 error
- 2026-11-06（链接到知识库）：改为多选 + 目标知识库选择 / 就地新建；修掉 `createNote` 漏传
  `notebookId` 导致笔记游离的问题；知识库列表卡片与知识树节点加远程来源云图标。
  前端 `tsc` 0 error，知识树渲染 / 树面板契约 / 笔记拖拽排序测试 8/8 通过
- 2026-11-08（WebDAV 换库 + 多根）：`remote-files-webdav` 18/18（`getPatcher()` 注入假 fetch：
  单根读写/改名/删除回退/错误映射、多根虚拟根与别名解析、非法别名 404）；后端 `tsc` 0 error
- 2026-11-08（SMB 修复）：`mapSmbError` 对已是 `RemoteProviderError` 的错误不再二次映射（认证失败曾从
  403 被洗成 502）；操作超时定时器随操作清除（泄漏会让进程/测试多挂 45s，该文件 48.2s → 1.8s）；
  `remote-files-smb` 14/14，remote-files 全家 47/47
- 2026-11-08（列目录性能）：SMB `list` 增加 `fast: true`（只 readdir，真机 200 条约 15-22ms），前端先出列表、
  后台补 stat（约 330-365ms）；前端加 `(源, 路径)` 会话缓存（TTL 30s，刷新/增删改强制重拉）。
  后端 32/32、前后端 `tsc` 0 error；真机实测首屏 135ms 出内容、348ms 补齐详情，二次进入命中缓存 0 请求
- 2026-11-08（刷新剔除已删除项）：SMB 虚拟根/WebDAV 多根支持 `revalidate`，只剔除「对象不存在」类错误，
  主机离线与权限错误保留；剔除结果同步落库（源配置里的 `shares/rootPaths` 一并收敛），管理存储会显示
  「远端已不存在」的已选共享供手动取消。`remote-files` 33/33；真机实测 SMB 根目录刷新后已删除共享
  `workapce` 消失、管理存储由「3 个共享」变为「2 个共享」，再点根目录也不会回来
- 未验证（待用户实测）：真实 WebDAV/NAS 连通、百度 access_token 实际读写（含 >4MB 分片）、
  SMB 多共享真机遍历
