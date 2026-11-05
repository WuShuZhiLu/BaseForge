# 文件管理重设计方案

## 1. 背景与痛点

### 1.1 现状：三来源模型

BaseForge 当前的文件管理采用"三来源"分隔设计，前端通过 `FilesSource` 类型（定义于 `frontend/src/features/files/filesUi.ts`）将文件分为三大来源：

| 来源 | 标识值 | 入口图标 | 定位 | 文件类型范围 |
|------|--------|---------|------|-------------|
| **附件** | `"attachments"` | 📎 | 绑定文档的非图片文件 | PDF、Word、Excel、压缩包、音频、视频、Markdown 等所有非图片类型 |
| **图床** | `"imagehost"` | 🌐 | 公开直链分享的图片空间 | 仅 PNG / JPEG / WebP / GIF / SVG |
| **远程文件** | `"remote"` | ☁️ | 第三方源文件 | WebDAV / 百度网盘 / SMB 等远程源上的文件（内核能力，非插件） |

用户在侧栏（`frontend/src/components/SidebarDesktop.tsx`，约 3190 行附近）通过三个独立入口切换来源，每个来源有各自独立的筛选、排序和视图状态：

- **附件来源**：支持按文档类型 chips 筛选（PDF / Word / Markdown / 压缩包 / 音频 / 视频），排序选项含最新上传、最早上传、大小、名称
- **图床来源**：支持按图片格式 chips 筛选（PNG / JPG / WebP / GIF / SVG），排序选项含最近复制、最近上传、大小、名称
- **远程来源**：支持按类型 chips 筛选（文档 / 图片 / 压缩包 / 其他），排序选项含名称、修改时间、大小

### 1.2 核心问题

1. **视频/音频定位尴尬**：视频和音频文件在"附件"来源中管理，但实际使用场景中，视频经常需要像图片一样生成公开直链进行外链分享。放在"附件"里语义上暗示"私有绑定"，用户需要外链时感到困惑。

2. **"图床"概念过窄**：图床（image host）的命名和 UI 设计暗示仅支持图片，但用户同样有视频外链、音频外链的需求。当前设计下，视频无法进入图床，被迫留在附件。

3. **按来源分隔增加认知负担**：同一个文件因为上传方式不同（编辑器粘贴 vs 文件管理上传）或文件类型不同（图片 vs 非图片），被自动分到不同来源区域。用户找一个文件需要先回忆"这个文件当初是怎么上传的"。

4. **三套 UI 状态增加复杂度**：前端为三个来源分别维护了独立的筛选、排序、视图状态（参见 `filesUi.ts` 中的 `ihCategory`、`ihMimes`、`ihSort`、`ihTime` vs `category`、`sort`、`time` vs `remoteTypes`、`remoteSort`、`remoteTime`），代码复杂度高，用户学习成本也高。

5. **上传限制不合理**：图床来源仅接受图片类型，文件管理上传（附件来源）虽然不限制类型，但两个入口的上传流程在概念上割裂。

### 1.3 底层事实

**后端存储已经统一**：附件和图床在后端共用同一张 `attachments` 表和同一套物理存储目录。

`attachments` 表结构（定义于 `backend/src/db/schema.ts`）：

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  noteId TEXT NOT NULL,
  userId TEXT NOT NULL,
  filename TEXT NOT NULL,
  mimeType TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  -- 以下为迁移新增列
  hash TEXT,              -- SHA-256 去重
  "uploadSource" TEXT,    -- 上传来源标记（'file_manager' 等）
  "folderId" TEXT,        -- 文件夹归属
  "workspaceId" TEXT      -- 工作区归属
);
```

关键事实：
- **图片与非图片共存于同一张表**，通过 `mimeType` 字段区分类型
- **`uploadSource` 字段**仅用于内部追踪（如判定"我的上传"），不用于 UI 分隔
- **公开链接能力**（`backend/src/lib/file-public-origin.ts`）是通用的，技术上不限于图片
- **缩略图服务**（`backend/src/services/thumbnails.ts`）当前仅对图片 MIME 生成缩略图（使用 sharp 库），视频/音频无缩略图
- **媒体分析服务**（`backend/src/services/modern-media.ts`）已引入 ffmpeg，支持 Live Photo 视频提取

**问题本质在前端视图层**：后端的统一存储已经具备条件，是前端的三来源分隔设计制造了人为的割裂。

---

## 2. 竞品参考

### 2.1 Notion

- **模型**：单一文件存储，所有文件类型（图片、视频、PDF、代码文件等）统一管理
- **组织方式**：文件通过页面（Page）嵌入，没有独立的"文件管理器"概念
- **分享**：页面公开后，嵌入的所有文件自动获得公开访问链接
- **优势**：用户无需关心文件类型和存储位置，心智模型简单
- **局限**：缺少独立文件管理能力，大量文件时不易检索

### 2.2 语雀

- **模型**：双空间设计——"文档附件"（绑定文档，随文档走）+"附件管理"（独立空间，跨文档）
- **组织方式**：按使用场景分，而非按文件类型分
- **分享**：文档级分享，附件跟随文档
- **优势**：区分了"文档附属"和"独立资产"两种使用场景
- **局限**：两个入口仍有认知成本，且按场景分不如按类型分直观

### 2.3 Obsidian

- **模型**：统一 Vault 文件系统，所有文件（Markdown + 附件）都在文件夹树中
- **组织方式**：通过文件夹层级组织，插件支持图床（如 imgur 插件）
- **分享**：依赖插件或导出，原生不支持公开链接
- **优势**：文件系统透明，用户完全掌控
- **局限**：需要用户自行管理文件夹结构，无内置文件分类

### 2.4 Confluence

- **模型**：页面级附件，每个页面有自己的附件列表
- **组织方式**：通过页面层级组织，附件通过宏（Macro）嵌入媒体
- **分享**：页面级权限控制，附件跟随页面
- **优势**：与企业权限体系深度集成
- **局限**：缺少全局文件视图，找文件需要先找到对应页面

### 2.5 小结：BaseForge 的选择

| 维度 | Notion | 语雀 | Obsidian | Confluence | **BaseForge（新）** |
|------|--------|------|----------|------------|-------------------|
| 文件池 | 统一 | 双空间 | 统一（文件夹） | 页面级 | **统一文件池** |
| 分类方式 | 无 | 按场景 | 按文件夹 | 按页面 | **按类型筛选** |
| 公开链接 | 页面级 | 文档级 | 无（插件） | 页面级 | **文件级** |
| 媒体嵌入 | 内联 | 内联 | 内联 | 宏 | **内联（图片/视频/音频）** |

BaseForge 的独特优势：**底层存储已统一**（`attachments` 单表），只需重新设计前端视图层，无需数据迁移。

---

## 3. 核心设计理念

### 3.1 设计原则

**原则一：统一文件池**

所有文件（图片、视频、音频、文档、压缩包等）存储在一个统一的文件池中，不再按上传方式或来源分隔。用户打开文件管理器看到的就是"我的所有文件"。

**原则二：类型是筛选维度，不是分隔维度**

文件类型（图片/视频/音频/文档/其他）作为筛选条件（filter），而非分隔容器（container）。同一个文件池通过类型 chips 快速缩小范围，但不会把文件"锁"在某个分类里。

**原则三：公开链接是文件属性，不是来源特权**

任何文件都可以生成公开直链，不限于图片。"公开链接"是文件的一个状态属性（有/无），而非某个特定来源的专属能力。

**原则四：媒体类型决定展示方式，不决定存储位置**

图片、视频、音频在编辑器中内联展示（inline），PDF、Word 等生成附件链接。但无论展示方式如何，它们都存储在同一个文件池中。

### 3.2 新旧模型对比

**旧模型：三来源分隔**

```
┌─────────────────────────────────────────────┐
│  📎 附件          🌐 图床          ☁️ 远程  │  ← 侧栏三个入口
├─────────────────────────────────────────────┤
│                                             │
│  PDF │ Word │ 压缩包 │ 音频 │ 视频          │  ← 附件来源按类型 chips 筛选
│                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                             │
│  PNG │ JPG │ WebP │ GIF │ SVG              │  ← 图床来源按图片格式 chips 筛选
│                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                             │
│  文档 │ 图片 │ 压缩包 │ 其他                │  ← 远程来源按后缀类型 chips 筛选
│                                             │
└─────────────────────────────────────────────┘
```

**新模型：统一文件池 + 类型筛选**

```
┌─────────────────────────────────────────────┐
│  📁 文件                          ☁️ 远程* │  ← 侧栏：文件 + 远程（远程待讨论）
├─────────────────────────────────────────────┤
│                                             │
│  [全部] [图片] [视频] [音频] [文档] [其他]  │  ← 统一类型 chips
│                                             │
│  🔍 搜索框  │ 排序 ▼ │ 网格/列表 │ 分享状态│  ← 辅助筛选
│                                             │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐          │
│  │ 🖼️  │ │ 🎬  │ │ 🎵  │ │ 📄  │          │  ← 所有类型文件混合展示
│  │ 文件1│ │ 文件2│ │ 文件3│ │ 文件4│          │
│  │ 🔗  │ │ 🔗  │ │     │ │     │          │  ← 公开链接状态标识
│  └─────┘ └─────┘ └─────┘ └─────┘          │
│                                             │
└─────────────────────────────────────────────┘

* 远程文件是否融入统一池待讨论（见第 9 节）
```

---

## 4. 前端 UI 变更

### 4.1 侧栏变更

**文件**：`frontend/src/components/SidebarDesktop.tsx`（约 3190 行附近）

- **移除**："附件"（📎）和"图床"（🌐）两个独立入口
- **新增**：单一"文件"（📁）入口，替代原有两个来源
- **保留**："远程文件"（☁️）入口（待讨论，见第 9 节）
- **变更**：入口角标从分来源计数改为统一文件总数

**状态影响**：

`frontend/src/features/files/filesUi.ts` 中的 `FilesSource` 类型：

```typescript
// 当前
export type FilesSource = "attachments" | "imagehost" | "remote";

// 变更后
export type FilesSource = "all" | "remote";  // "all" 为统一文件池
```

localStorage 键 `"nowen.filesUi.source"` 的旧值 `"attachments"` 和 `"imagehost"` 需兼容映射为 `"all"`。

### 4.2 文件管理中心变更

**文件**：`frontend/src/components/FileManager.tsx`（2492 行）

#### 4.2.1 类型筛选条

替换来源 Tab，改为统一类型 chips：

| 筛选项 | chip key | 对应 MIME 类型匹配规则 | 状态 |
|--------|----------|----------------------|------|
| 全部 | `"all"` | 所有类型 | 默认选中 |
| 图片 | `"image"` | `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/svg+xml`, `image/bmp`, `image/avif`, `image/heic`, `image/heif` | 已实现（后端 `isImage()` 函数） |
| 视频 | `"video"` | `video/mp4`, `video/webm`, `video/quicktime`, `video/x-m4v`, `video/ogg` 等 `video/*` 前缀 | 需新增 |
| 音频 | `"audio"` | `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/flac`, `audio/aac`, `audio/mp4`, `audio/opus`, `audio/amr` 等 `audio/*` 前缀 | 需新增 |
| 文档 | `"doc"` | `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.*`, `text/markdown`, `text/plain`, `application/zip`, `application/x-rar`, `application/gzip` 等 | 需新增 |
| 其他 | `"other"` | 不属于以上分类的文件 | 需新增 |

**实现要点**：

- 类型判定函数需在后端和前端各实现一份（后端用于 SQL WHERE，前端用于客户端过滤）
- 后端建议新增 `backend/src/lib/mime-category.ts`，导出 `getMimeCategory(mime: string): "image" | "video" | "audio" | "doc" | "other"` 函数
- 前端在 `frontend/src/features/files/filesUi.ts` 中新增统一的类型 chips 定义，替代当前分散的 `FILE_DOC_MIME_CHIPS` 和 `FILE_IMAGE_MIME_CHIPS`

**参考现有代码**：

当前 `filesUi.ts` 中附件来源的类型 chips（第 147-154 行）：

```typescript
export const FILE_DOC_MIME_CHIPS: Array<{ key: string; label: string; mimes: string[] }> = [
  { key: "pdf", label: "PDF", mimes: ["application/pdf"] },
  { key: "word", label: "Word", mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"] },
  { key: "md", label: "Markdown", mimes: ["text/markdown", "text/plain"] },
  { key: "zip", label: "压缩包", mimes: ["application/zip", "application/x-zip-compressed", "application/gzip"] },
  { key: "audio", label: "音频", mimes: ["audio/"] },
  { key: "video", label: "视频", mimes: ["video/"] },
];
```

新设计将此概念提升为全文件池级别的类型筛选，不再局限于附件来源。

#### 4.2.2 辅助筛选

| 功能 | 当前状态 | 变更说明 |
|------|---------|---------|
| **搜索框** | 已实现 | 保持不变，作用于全文件池 |
| **排序选项** | 已实现（`FILE_SORT_OPTIONS`） | 合并图床来源的排序选项，新增"最近复制"（原图床 `copied_desc`）和"最近引用"选项 |
| **视图切换** | 已实现（网格/列表） | 保持不变 |
| **时间筛选** | 已实现（全部/今天/本周/本月/更早） | 保持不变，作用于全文件池 |
| **是否有公开链接** | 未实现 | **新增**：可选筛选"已分享"/"未分享" |
| **是否被引用** | 部分实现（`filter=unreferenced`） | 增强：作为可选筛选 chip |
| **文件夹** | 已实现（`FilesGroupMode`） | 保持不变 |

**排序选项完整列表**（合并后）：

```typescript
const UNIFIED_SORT_OPTIONS = [
  { value: "created_desc", label: "最新上传" },
  { value: "created_asc", label: "最早上传" },
  { value: "size_desc", label: "大小 ↓" },
  { value: "size_asc", label: "大小 ↑" },
  { value: "name_asc", label: "名称 A→Z" },
  { value: "name_desc", label: "名称 Z→A" },
  { value: "referenced_desc", label: "最近引用" },  // 新增
  { value: "shared_desc", label: "最近分享" },       // 新增
];
```

#### 4.2.3 文件卡片设计

**网格视图卡片**：

```
┌──────────────────┐
│   [缩略图/图标]   │
│                  │
│  🔗              │  ← 公开链接状态角标
│                  │
├──────────────────┤
│ 文件名.ext       │
│ 2.3 MB · 3篇引用 │
└──────────────────┘
```

**列表视图行**：

```
| [图标] 文件名.ext  | 2.3 MB | 2024-01-15 | 图片 | 🔗 | 3篇引用 | 操作 ▼ |
```

**卡片元素说明**：

| 元素 | 说明 | 当前状态 |
|------|------|---------|
| 缩略图/类型图标 | 图片显示缩略图（已有，`thumbnailUrl`），视频显示首帧海报（**需新增**），音频显示波形图标或默认图标，其他类型显示 MIME 对应图标 | 图片已实现，其他需新增 |
| 文件名 | 完整文件名，超长截断加省略号 | 已实现 |
| 文件大小 | 人类可读格式（KB/MB/GB） | 已实现 |
| 公开链接状态指示器 | 有公开链接时显示 🔗 角标，无则不显示 | 图床来源已有，需扩展到所有类型 |
| 引用计数 | 显示"X篇引用"，点击可跳转引用列表 | 已实现（详情面板） |
| 类型标签 | 列表视图中显示类型分类（图片/视频/音频/文档/其他） | **需新增** |

### 4.3 上传流程变更

**文件**：`frontend/src/components/FileUploadDialog.tsx`

| 变更项 | 当前行为 | 新行为 |
|--------|---------|--------|
| 上传入口 | 附件来源和图床来源各有独立上传流程 | 统一上传按钮，不限制文件类型 |
| 图床限制 | 图床仅支持图片类型（PNG/JPG/WebP/GIF/SVG） | **移除限制**，任何类型均可上传 |
| 上传目标 | 自动归入对应来源 | 所有文件进入统一文件池 |
| 编辑器内上传 | 图片内联，其他类型生成附件链接 | 图片/视频/音频直接内嵌播放器，其他类型生成附件链接 |

**编辑器内媒体嵌入规则**（需设计）：

| 文件类型 | 嵌入方式 | 当前状态 |
|---------|---------|---------|
| 图片 | 内联显示 `<img>` | 已实现（Tiptap image 节点） |
| 视频 | 内联播放器 `<video>` | **需新增**（Tiptap video 节点设计） |
| 音频 | 内联播放器 `<audio>` | **需新增**（Tiptap audio 节点设计） |
| PDF | 附件链接卡片 | 已实现 |
| 其他 | 附件链接卡片 | 已实现 |

### 4.4 文件详情抽屉变更

**文件**：`frontend/src/components/attachmentDetail/AttachmentDetailDrawer.tsx`

#### 统一详情面板

所有文件类型共用同一个详情抽屉，根据 MIME 类型动态调整预览区：

```
┌─────────────────────────────────────┐
│  [预览区]                           │
│  - 图片：大图查看器（已有）          │
│  - 视频：视频播放器（需新增）        │
│  - 音频：音频播放器（需新增）        │
│  - PDF：PDF 预览/下载（需新增）      │
│  - 其他：文件图标 + 信息             │
├─────────────────────────────────────┤
│  文件名：example.mp4                │
│  大小：12.5 MB                      │
│  类型：video/mp4                    │
│  上传时间：2024-01-15 14:30         │
│  上传方式：文件管理                  │
├─────────────────────────────────────┤
│  🔗 公开链接                        │
│  [生成公开链接] / [复制链接]         │  ← 所有类型均可
│  格式：URL / Markdown / HTML        │
├─────────────────────────────────────┤
│  📎 引用信息                        │
│  被 3 篇文档引用：                   │
│  - 项目笔记 A                       │
│  - 会议纪要 B                       │
│  - 技术方案 C                       │
├─────────────────────────────────────┤
│  [下载] [重命名] [移动文件夹] [删除] │
└─────────────────────────────────────┘
```

**关键变更**：

| 区域 | 当前行为 | 新行为 |
|------|---------|--------|
| 预览区 | 图片大图 / 非图片文件信息 | 图片大图 / 视频播放器 / 音频播放器 / PDF 预览 / 文件图标 |
| 公开链接区 | 仅图床来源的图片显示 | **所有文件类型**均可生成和复制公开链接 |
| 链接格式 | 图片用 `![alt](url)`，其他用 `[name](url)` | 视频用 `<video src="url">`，音频用 `<audio src="url">`，其他保持现有逻辑 |

---

## 5. 公开链接体系

### 5.1 扩展策略

**当前状态**：

- 公开链接基础设施已完备（`backend/src/lib/file-public-origin.ts`）
- 链接格式：`{filePublicOrigin}/api/attachments/{id}`
- 当前仅图床来源的图片在 UI 上暴露公开链接功能

**扩展策略**：

- **从"图床专属"扩展为"全文件类型"**：任何 MIME 类型的附件均可生成公开直链
- **UI 暴露条件**：文件详情抽屉中，所有文件类型均显示"公开链接"区域
- **链接格式不变**：`{filePublicOrigin}/api/attachments/{id}`，已有的公开地址配置（环境变量 `FILE_PUBLIC_ORIGIN` / `NOWEN_FILE_PUBLIC_ORIGIN` / 系统设置 `site_file_public_origin`）继续生效
- **HTTP Range 支持**：当前后端 `attachments-core.ts` 的附件下载路由已支持 `?inline=1` 参数跳过 `Content-Disposition: attachment`，确保视频/音频可流式播放（需确认是否已实现 HTTP Range 206 响应，如未实现需新增）

### 5.2 复制格式

**当前实现**：`frontend/src/lib/imageHostFormats.ts` 中的 `formatImageHostSnippet()` 函数

当前仅支持图片格式（`<img>` 标签），需扩展为通用格式：

| 格式类型 | 图片/视频（媒体类型） | 其他文件 |
|---------|-------------------|---------|
| **URL** | 纯链接 URL | 纯链接 URL |
| **Markdown** | `![filename](url)` | `[filename](url)` |
| **HTML** | 图片：`<img src="url" alt="filename" />`<br>视频：`<video src="url" controls></video>`<br>音频：`<audio src="url" controls></audio>` | `<a href="url">filename</a>` |

**建议重构**：

将 `imageHostFormats.ts` 重命名为 `fileLinkFormats.ts`（或保留旧文件名但扩展函数），新增 `formatFileLinkSnippet(format, url, filename, mimeType)` 函数，根据 MIME 类型自动选择媒体标签或链接标签。

### 5.3 UI 标识变更

| 元素 | 当前 | 变更后 |
|------|------|--------|
| 公开链接角标 | 图床来源的图片显示"直链"角标（紫色高亮） | 所有文件类型统一显示"已分享"角标（通用图标 + 颜色标识） |
| 筛选器 | 无"是否有公开链接"筛选 | 新增"已分享/未分享"辅助筛选选项 |
| 统计 | 图床来源单独统计图片数量和大小 | 统一统计各类型文件数量和大小 |

---

## 6. 媒体处理策略

### 6.1 图片

| 能力 | 状态 | 实现细节 |
|------|------|---------|
| 缩略图生成 | ✅ 已实现 | `backend/src/services/thumbnails.ts`，使用 sharp 库，240/480/960 三档宽度，缓存于 `.thumbs/` 目录，WebP 格式 |
| 内嵌预览 | ✅ 已实现 | 编辑器内 Tiptap image 节点，`/api/attachments/:id?w=240` 缩略图 + 原图 lazy load |
| 公开直链 | ✅ 已实现 | `{origin}/api/attachments/{id}` |
| HEIF/HEIC 支持 | ✅ 已实现 | `backend/src/services/heif-preview.ts`，转 WebP 预览 |
| Live Photo 处理 | ✅ 已实现 | `backend/src/services/modern-media.ts`，分析媒体类型并关联照片+视频 |
| Hash 去重 | ✅ 已实现 | SHA-256 hash，相同文件不重复存储 |

### 6.2 视频

| 能力 | 状态 | 实现细节 |
|------|------|---------|
| 缩略图生成 | ❌ **需新增** | 使用 ffmpeg 提取首帧作为海报图（poster），缓存于 `.thumbs/{id}_poster.webp`。后端已有 `ffmpeg-static` 依赖（`modern-media.ts` 中 `getMediaFfmpegPath()`），可复用 |
| 内嵌播放 | ❌ **需新增/需设计** | 编辑器内视频播放组件，Tiptap 新增 video 节点，渲染 `<video controls src="url">` |
| 公开直链 | ⚠️ **需扩展** | 基础设施已有，需：1) UI 暴露公开链接按钮；2) 确保 `?inline=1` 参数正确返回 `Content-Type: video/mp4` 而非触发下载 |
| HTTP Range 支持 | ⚠️ **需确认** | 视频拖动播放需要 HTTP 206 Partial Content 支持，当前 `attachments-core.ts` 未见 Range 处理逻辑，**需新增** |
| 流式传输 | ⚠️ **需确认** | 大视频文件应使用 stream 而非 buffer 读取，需确认当前实现 |

**ffmpeg 缩略图命令参考**（基于现有 `modern-media.ts` 中的 ffmpeg 调用模式）：

```bash
ffmpeg -i input.mp4 -ss 00:00:01 -vframes 1 -vf "scale=trunc(min(480,iw)/2)*2:-2" -q:v 5 output.webp
```

### 6.3 音频

| 能力 | 状态 | 实现细节 |
|------|------|---------|
| 缩略图/封面 | ❌ **需新增** | 可选方案：默认音频图标 / 提取嵌入式封面（ID3 tag） / 生成波形图 |
| 内嵌播放 | ❌ **需新增/需设计** | 编辑器内音频播放组件，Tiptap 新增 audio 节点，渲染 `<audio controls src="url">` |
| 公开直链 | ⚠️ **需扩展** | 同视频，需 UI 暴露 + inline 支持 |
| 波形可视化 | 🔮 **未来优化** | 可选增强功能，使用 Web Audio API 或后端生成波形图 |

---

## 7. 后端变更要点

### 7.1 API 变更

#### `GET /api/files`（列表接口）

**文件**：`backend/src/routes/files.ts`（1518 行），第 377 行附近

| 参数 | 当前 | 变更后 |
|------|------|--------|
| `category` | 用于分隔来源（`"image"` / `"file"`） | **保留但降级为可选元数据标记**，不再作为 UI 分隔维度。默认不传时返回所有类型 |
| `type` / `mimeCategory` | 附件来源有 `mimes` 参数（MIME 前缀匹配） | **新增** `mimeCategory` 参数，取值 `"image"` / `"video"` / `"audio"` / `"doc"` / `"other"`，后端通过 `getMimeCategory()` 函数映射 |
| `source` | 无（前端状态，不传后端） | 可选新增 `uploadSource` 筛选（内部追踪用，UI 不暴露） |

**SQL 变更示例**：

```sql
-- 当前：按来源分隔查询
SELECT ... FROM attachments WHERE mimeType LIKE 'image/%'  -- 图床
SELECT ... FROM attachments WHERE mimeType NOT LIKE 'image/%'  -- 附件

-- 变更后：统一查询 + 类型筛选
SELECT ... FROM attachments WHERE getMimeCategory(mimeType) = ?  -- 按类型
SELECT ... FROM attachments  -- 全部（不加类型条件）
```

> 注：SQLite 不支持在 WHERE 中直接调用 JS 函数，实际实现需在 JS 层做 MIME 分类映射，生成 SQL WHERE 条件（如 `mimeType LIKE 'video/%' OR mimeType LIKE 'audio/%'`）。

#### `GET /api/files/stats`（统计接口）

**文件**：`backend/src/routes/files.ts`，第 622 行附近

当前返回结构：

```typescript
{
  total, totalBytes,
  images: { count, bytes },
  files: { count, bytes },
  unreferenced: { count, bytes },
  myUploads: { total, referenced, unreferenced },
  storage, byMime
}
```

**变更后**：扩展为按 MIME 大类统计

```typescript
{
  total, totalBytes,
  images: { count, bytes },      // 保留
  videos: { count, bytes },      // 新增
  audios: { count, bytes },      // 新增
  documents: { count, bytes },   // 新增
  others: { count, bytes },      // 新增
  files: { count, bytes },       // 保留兼容（非图片总和）
  unreferenced: { count, bytes },
  myUploads: { total, referenced, unreferenced },
  storage, byMime
}
```

#### 公开链接接口

**文件**：`backend/src/routes/attachments-core.ts`（1797 行）

当前 `GET /api/attachments/:id` 已支持所有文件类型的下载/预览，`?inline=1` 参数可跳过 `Content-Disposition: attachment`。

**需确认/新增**：

1. **HTTP Range 支持**（视频/音频拖动播放必需）：检查当前是否已实现 `Range` 请求头的处理，返回 `206 Partial Content`。如未实现，需在附件下载路由中新增 Range 解析和分段响应逻辑。

2. **MIME 类型正确性**：确保视频文件返回 `Content-Type: video/mp4`，音频文件返回正确的 `Content-Type: audio/mpeg` 等（当前已通过 `row.mimeType` 设置，应无需改动）。

3. **CORS 头**：如果公开链接需要被外部网站嵌入（如 `<video>` 跨域），需确认 CORS 配置。

### 7.2 缩略图扩展

**文件**：`backend/src/services/thumbnails.ts`

| 变更 | 说明 | 优先级 |
|------|------|--------|
| 视频缩略图 | 使用 ffmpeg 提取首帧/指定时间帧作为 WebP 海报图。新增 `isVideoThumbnailable()` 判断 `video/*` MIME，新增 `getOrCreateVideoThumbnail()` 调用 ffmpeg | **第二阶段** |
| 音频缩略图 | 默认音频图标，或提取 ID3 嵌入式封面。可作为 fallback 使用统一图标 | **第二阶段** |
| `isThumbnailable()` 扩展 | 当前仅判断图片 MIME（排除 SVG/ICO），需扩展支持视频 MIME | **第二阶段** |

### 7.3 数据模型

**`attachments` 表结构不变**——当前表结构已经足够灵活：

| 字段 | 用途变更 |
|------|---------|
| `id` | 不变 |
| `noteId` | 不变（仍为外键关联） |
| `userId` | 不变 |
| `filename` | 不变 |
| `mimeType` | **重要性提升**：从辅助字段变为核心分类依据 |
| `size` | 不变 |
| `path` | 不变 |
| `hash` | 不变（SHA-256 去重） |
| `uploadSource` | **语义降级**：从"来源分隔依据"降级为"可选的内部追踪标记"，UI 不再使用 |
| `folderId` | 不变（保留文件夹组织维度） |
| `workspaceId` | 不变 |

**新增表/字段**：无需新增。

### 7.4 关键代码文件

#### 前端需修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `frontend/src/features/files/filesUi.ts` | 1) `FilesSource` 类型新增 `"all"` 值；2) 新增统一类型 chips 定义 `UNIFIED_MIME_CHIPS`；3) 合并排序选项；4) localStorage 兼容映射 |
| `frontend/src/components/FileManager.tsx` | 1) 移除来源 Tab 切换 UI；2) 新增统一类型筛选 chips；3) 文件卡片增加类型标签和分享状态指示器；4) 统一数据请求逻辑（不再按来源分调不同接口参数） |
| `frontend/src/components/SidebarDesktop.tsx` | 1) 合并"附件"和"图床"入口为"文件"；2) 更新角标计数逻辑 |
| `frontend/src/components/FileUploadDialog.tsx` | 1) 移除文件类型限制；2) 统一上传流程 |
| `frontend/src/components/attachmentDetail/AttachmentDetailDrawer.tsx` | 1) 统一所有文件类型的详情面板；2) 新增视频/音频预览播放器；3) 公开链接区域扩展到所有类型 |
| `frontend/src/lib/imageHostFormats.ts` | 1) 扩展 `formatImageHostSnippet()` 支持视频/音频标签；2) 或新增 `fileLinkFormats.ts` |
| `frontend/src/types/index.ts`（或相关类型文件） | 新增 `MimeCategory` 类型定义 |

#### 后端需修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `backend/src/routes/files.ts` | 1) `GET /api/files` 新增 `mimeCategory` 查询参数；2) `GET /api/files/stats` 扩展视频/音频统计；3) 移除 `category` 参数的强制分隔逻辑 |
| `backend/src/routes/attachments-core.ts` | 1) 确认/新增 HTTP Range 支持（206 响应）；2) 确保 `?inline=1` 对视频/音频正确工作 |
| `backend/src/services/thumbnails.ts` | 1) 新增视频缩略图生成（ffmpeg 首帧提取）；2) 扩展 `isThumbnailable()` 支持视频 MIME |
| `backend/src/lib/file-public-origin.ts` | 无需修改（已通用），但可考虑重命名为更通用的名称 |
| `backend/src/lib/mime-category.ts` | **新增文件**：MIME 类型分类函数 `getMimeCategory()` |
| `backend/src/db/schema.ts` | 无需修改（表结构不变） |

---

## 8. 迁移策略

### 8.1 前端状态迁移

**localStorage 键兼容映射**：

```typescript
// frontend/src/features/files/filesUi.ts

export function getFilesSource(): FilesSource {
  const raw = localStorage.getItem(KEYS.source) as string | null;
  // 兼容旧值：attachments / imagehost → all
  if (raw === "attachments" || raw === "imagehost") return "all";
  if (raw === "remote") return "remote";
  return "all"; // 默认统一文件池
}
```

**类型筛选状态**：

- 新增 localStorage 键 `"nowen.filesUi.unifiedType"` 存储统一类型筛选偏好
- 旧键 `"nowen.filesUi.ihCategory"` / `"nowen.filesUi.category"` 在首次访问时尝试迁移：
  - `"image"` → 新值 `"image"`
  - `"myUploads"` / `"unreferenced"` → 保留为辅助筛选
  - 其他 → 默认 `"all"`

### 8.2 用户习惯迁移

| 策略 | 说明 |
|------|------|
| **引导提示** | 首次打开新版文件管理时，显示一次性引导提示（toast 或 modal），说明："附件和图床已合并为统一的文件空间，所有文件类型均可生成公开链接" |
| **无数据迁移** | 底层存储不变（`attachments` 表），无需执行数据迁移脚本 |
| **渐进适应** | 类型筛选 chips 的视觉设计与原来源 tabs 保持一定相似度，降低学习成本 |

### 8.3 向后兼容

| 兼容项 | 策略 |
|--------|------|
| **现有公开链接** | 保持有效，URL 格式不变（`{origin}/api/attachments/{id}`） |
| **API 参数** | `category` 参数仍可用但标记为 deprecated，新参数 `mimeCategory` 优先 |
| **前端 API 调用** | `FilesSource` 旧值 `"attachments"` / `"imagehost"` 在读取时自动映射为 `"all"` |
| **远程文件** | 接口不变，`FilesSource = "remote"` 保留；0.2.0 起由内置插件改为内核能力，无启停开关 |

---

## 9. 待讨论事项

### 9.1 远程文件定位

**问题**：远程文件（WebDAV / 百度网盘 / SMB）是融入统一文件池，还是保持独立入口？

| 方案 | 描述 | 优势 | 劣势 |
|------|------|------|------|
| **方案 A：融入统一池** | 远程文件与本地文件在同一池子，通过来源标签（`uploadSource` 或新字段）区分 | 真正的"统一"体验 | 远程文件涉及不同认证/访问模式，混合后增加复杂度 |
| **方案 B：保持独立** | 远程文件保持独立入口，但 UI 风格（卡片、筛选、排序）统一 | 实现简单，认证隔离清晰 | 仍有两个入口，未完全统一 |

**建议**：**方案 B**——保持独立入口。理由：远程文件的认证（WebDAV 密码、百度网盘 OAuth）、访问模式（在线 vs 离线）、文件元数据（远程路径 vs 本地路径）与本地文件差异较大，强行合并会增加不必要的复杂度。UI 风格统一即可解决认知割裂问题。

### 9.2 文件夹体系

**问题**：现有附件文件夹（`folderId`）是否保留？

**建议**：**保留**。文件夹作为可选的组织维度，与类型筛选正交。用户可以同时使用"文件夹 + 类型筛选"两个维度管理文件。不引入 Obsidian 式的完整文件夹树，保持轻量。

### 9.3 默认视图

**问题**：打开文件管理时的默认筛选状态？

**建议**：默认"全部"类型，记住用户上次的筛选选择（localStorage 持久化）。排序默认"最新上传"。

### 9.4 视频缩略图

**问题**：是否实现视频缩略图（首帧提取）？

**建议**：**实现，但作为第二阶段**。理由：
- 视频缩略图需要 ffmpeg 调用，增加服务端负载
- 需要新增 `.thumbs/{id}_poster.webp` 缓存逻辑
- 第一阶段的视频卡片可以先使用统一的视频类型图标，功能不受影响
- 第二阶段再引入懒生成缩略图（首次请求时生成并缓存）

### 9.5 编辑器内媒体嵌入

**问题**：视频/音频在编辑器内的嵌入方式？

| 媒体类型 | 嵌入方式 | 状态 |
|---------|---------|------|
| 图片 | 内联显示（`<img>`） | ✅ 已实现 |
| 视频 | 内联播放器（`<video controls>`） | ❌ 需设计 Tiptap video 节点 |
| 音频 | 内联播放器（`<audio controls>`） | ❌ 需设计 Tiptap audio 节点 |

**建议**：作为独立设计议题，不在本方案范围内详细展开。但本方案的公开链接体系需确保生成的链接格式兼容未来内嵌播放器的需求（如 Markdown 格式使用 `![filename](url)` 同时适用于图片和视频）。

### 9.6 "图床"术语

**问题**：是否保留"图床"名称？

**建议**：
- **前端 UI**：移除"图床"术语，统一使用"公开链接"或"分享链接"
- **后端代码**：`imagehost` 相关标识（如 `FilesSource = "imagehost"`、`uploadSource = "imagehost"`）作为内部标识保留，标记为 deprecated，在后续版本逐步废弃
- **数据库**：`uploadSource` 字段中已有的 `"imagehost"` 值不做迁移，保持原样
- **API**：不新增 `imagehost` 相关 API，现有接口参数兼容

---

## 10. 实施路线（建议）

### 第一阶段：统一视图（核心变更）

**目标**：合并三来源为统一文件池，消除来源分隔的认知负担。

| 任务 | 涉及文件 | 预估工作量 |
|------|---------|-----------|
| 新增 `mime-category.ts` MIME 分类工具 | `backend/src/lib/mime-category.ts`（新建） | 小 |
| 扩展 `GET /api/files` 支持 `mimeCategory` 参数 | `backend/src/routes/files.ts` | 中 |
| 扩展 `GET /api/files/stats` 视频/音频统计 | `backend/src/routes/files.ts` | 小 |
| 重构 `filesUi.ts` 统一类型 chips 和排序 | `frontend/src/features/files/filesUi.ts` | 中 |
| 合并侧栏"附件"和"图床"入口为"文件" | `frontend/src/components/SidebarDesktop.tsx` | 中 |
| 重构 `FileManager.tsx` 移除来源 Tab，新增统一类型筛选 | `frontend/src/components/FileManager.tsx` | 大 |
| 移除 `FileUploadDialog.tsx` 文件类型限制 | `frontend/src/components/FileUploadDialog.tsx` | 小 |
| 公开链接 UI 扩展到所有文件类型 | `frontend/src/components/attachmentDetail/AttachmentDetailDrawer.tsx` | 中 |
| 重构 `imageHostFormats.ts` 支持视频/音频标签 | `frontend/src/lib/imageHostFormats.ts` | 小 |
| localStorage 兼容映射 + 一次性引导提示 | 多个前端文件 | 小 |

**验证标准**：
- 用户打开文件管理看到所有文件的统一列表
- 类型 chips 可以正确筛选图片/视频/音频/文档/其他
- 任何文件类型都可以生成和复制公开链接
- 旧的公开链接保持有效
- 侧栏只有一个"文件"入口（远程文件保持独立）

### 第二阶段：媒体增强

**目标**：增强视频/音频的预览和播放体验。

| 任务 | 涉及文件 | 预估工作量 |
|------|---------|-----------|
| 视频缩略图生成（ffmpeg 首帧提取） | `backend/src/services/thumbnails.ts` | 中 |
| 确认/实现 HTTP Range 支持（206 响应） | `backend/src/routes/attachments-core.ts` | 中 |
| 文件卡片视频缩略图显示 | `frontend/src/components/FileManager.tsx` | 小 |
| 详情抽屉视频播放器 | `frontend/src/components/attachmentDetail/AttachmentDetailDrawer.tsx` | 中 |
| 详情抽屉音频播放器 | `frontend/src/components/attachmentDetail/AttachmentDetailDrawer.tsx` | 中 |

**验证标准**：
- 视频文件在网格视图中显示首帧缩略图
- 视频文件在详情抽屉中可以直接播放
- 音频文件在详情抽屉中可以直接播放
- 视频拖动播放流畅（Range 请求正常工作）

### 第三阶段：体验优化

**目标**：打磨细节体验。

| 任务 | 说明 |
|------|------|
| PDF 在线预览 | 详情抽屉中嵌入 PDF.js 预览 |
| 批量操作优化 | 批量移动文件夹、批量删除、批量生成公开链接 |
| 搜索增强 | 支持按文件名全文搜索、按 MIME 类型精确搜索 |
| "已分享/未分享"筛选 | 辅助筛选公开链接状态 |
| "最近引用"排序 | 按最近被文档引用的时间排序 |
| 文件统计仪表盘 | 按类型展示文件数量、总大小、趋势图 |
| 编辑器内视频/音频嵌入 | Tiptap video/audio 节点设计与实现（独立议题） |

---

## 第三阶段实施记录（2026-11-01）

验证 / 运行基线：`npm run dev`（vite :5173 + backend tsx watch :3001），不再走 Electron。

### 已落地

| 能力 | 落点 |
|---|---|
| 分类新增「文档引用」 | 侧栏 `SidebarDesktop.tsx` + `filesUi.getFilesCategory()` 认 `referenced`；列表走 `filter=referenced` |
| 分享状态筛选（已分享 / 未分享） | 侧栏新分组 `FILE_SHARE_OPTIONS`；`shareStatus=shared\|unshared`，只算 isActive 且未过期 |
| 「最近引用」排序 | `sort=referenced_desc`，无引用附件沉底 |
| 搜索增强 | `q` 同时命中文件名与 MIME（输 `pdf` / `jpeg` / `video/` 都能找到） |
| 批量归档到文件夹 | 新增 `POST /api/files/batch-move`（单次 ≤200，目标文件夹归属校验，单事务） |
| 批量生成公开链接 | 批量栏按钮，逐个 `POST /api/attachments/:id/share` 后整体复制链接 |
| 按类型统计 | 类型 chips 内联个数 + title 里带总字节；侧栏「文档引用」带徽标 |
| 顺带修复 | `api.files.list` 从未序列化 `uploadedWithin`，侧栏「上传时间」筛选此前静默失效 |

### 关键发现：/api/files 的响应有三层实现

```
routes/files.ts            原始路由（计算列表 + 分页 + stats）
  → knowledgeFilesCapabilityGuard   知识树可见性收口：**整体重建**列表与分页
  → fileOrphanVisibility            孤儿即时视图 / 来源笔记修正
```

收口层只认它自己实现的 query 参数。第一阶段把 `mimeCategory` 加在路由里、第三阶段把
`shareStatus` / `filter=referenced` / `referenced_desc` / `referenceCount` 加在路由里，
**在真实应用里全部被静默丢弃**（实测：侧栏选「视频」仍旧返回全部附件）。
现已把口径上提为共用片段，两层一致：

- `lib/file-list-sql.ts` — `resolveFileListOrderBy` / `buildShareStatusWhere` / `buildKeywordWhere` / `appendIdSetWhere`
- `lib/attachment-reference-scan.ts` — 「文档引用 / 未引用」的内容扫描口径（严格互补，相加=全部，不看时间宽限期）
- 收口层额外补上 `mimeCategory` / `shareStatus` / `uploadedWithin` / `q` 的 MIME 命中 / `referenceCount`

回归锁定：`tests/files-list-visibility-guard-parity.test.ts`（走收口层的 5 个用例）。
**再加筛选维度时，路由与收口层两处都要改**，只改一层等于没改。

### 追加修复：「未引用」分类点进去是空的（2026-11-01）

用户报「未引用不工作」。实测 `GET /api/files?filter=unreferenced` 恒返回 `total 0`，
而同一批文件在「我的上传 → 还没用过的」子筛选里能看到 6 个。两个原因叠在一起：

1. **孤儿层用另一套口径重建了这个列表**。`fileOrphanVisibility` 在 `filter=unreferenced`
   时整体换成自己的查询：`attachment_references NOT EXISTS` **且** `uploadSource <> 'file_manager'`。
   后半句把「从文件管理手动上传的文件」全排除——而这正是「未引用」最典型的人群；
   前半句用倒排表，与走内容扫描的「文档引用」不互补（历史库没回填时会同时漏/重）。
   同一层还把 `stats.unreferenced` 覆写成同一口径，徽标与列表一起失效。
2. **内容扫描自带 24h 宽限期**，刚上传的文件两个分类都不进。宽限期属于「别自动删掉」
   的清理语义（`/api/data-file/cleanup-orphans` 自带 `graceHours=24`），不该套在浏览分类上。

处理：

- `filter=unreferenced` 的列表与 `stats.unreferenced` 一律由收口层用内容扫描给出（与
  「文档引用」同源互补）；`fileOrphanVisibility` 不再重建列表、不再覆写 stats，
  `buildImmediateOrphanList` / `getImmediateOrphanSummary` 删除；
- 扫描去掉宽限期；`routes/files.ts` 改 import `lib/attachment-reference-scan`，
  删掉本地重复实现（那份还留着宽限期，是第二个漂移源）；
- 「手动上传不该被自动清理」改由列表项的 `isManualUpload` / `isAutoCleanupProtected`
  标记表达（UI 绿色盾牌），不靠把文件从分类里藏起来；
- 顺带发现并修掉挂载顺序：`wrapKnowledgeRoute` 里先注册收口层、后注册孤儿修正层，
  后者跑在**内层**，它给列表项加的注解又被收口层的重建吹掉了——所以盾牌标记与
  「来源笔记修正」在真实应用里从未生效（`primaryNote` 一直显示 holder 笔记
  「未归档文件」）。改成孤儿层注册在外层。

回归锁定：`tests/files-unreferenced-category-stack.test.ts`（按生产顺序装齐三层，
断言手动上传进「未引用」且带盾牌、两个分类相加=全部、徽标同口径、来源笔记是真实引用笔记）。

修复后实测（dev 库 7 个附件，1 个被正文引用）：

| 查询 | 修复前 | 修复后 |
|------|--------|--------|
| `filter=unreferenced` | 0 | 6（`isAutoCleanupProtected: true`、`primaryNote: null`） |
| `filter=referenced` | 1 | 1（`primaryNote` = 真实引用笔记） |
| `stats` | referenced 1 / unreferenced 0 | referenced 1 / unreferenced 6（1+6=7 ✅） |

### 未做 / 已知局限

- PDF 在线预览：按要求本期不做。
- 统计趋势图：后端没有时序聚合数据源（只有当前快照），本期只做了「按类型数量 + 总大小」。
- 编辑器内 Tiptap video/audio 节点：见 9.5，仍是独立议题。
- `attachment_references` 是写时维护（笔记保存 / 导入 / 迁移），没有历史 backfill：
  老库里大批附件的最新引用时间为空，「最近引用」会退化为「最新上传」——排序末尾加了
  `a.createdAt DESC, a.id ASC` 决胜位，保证退化时分页顺序仍然稳定（无决胜位会重复/漏项）。
- `referenceCount` 已在列表下发，但卡片 / 表格暂未展示（等确定要放在哪一列再上 UI）。

## 附录 A：现有代码结构速查

| 模块 | 文件路径 | 行数 | 职责 |
|------|---------|------|------|
| 文件管理主组件 | `frontend/src/components/FileManager.tsx` | ~2492 | 文件列表、筛选、排序、上传、卡片渲染 |
| 文件 UI 状态 | `frontend/src/features/files/filesUi.ts` | ~252 | localStorage 持久化的筛选/排序/视图状态 |
| 上传对话框 | `frontend/src/components/FileUploadDialog.tsx` | - | 文件上传流程 |
| 详情抽屉 | `frontend/src/components/attachmentDetail/AttachmentDetailDrawer.tsx` | - | 文件详情、预览、公开链接复制 |
| 侧栏 | `frontend/src/components/SidebarDesktop.tsx` | ~3190 | 三来源切换入口 UI |
| 图床格式化 | `frontend/src/lib/imageHostFormats.ts` | ~54 | 公开链接的 URL/Markdown/HTML 格式化 |
| 文件路由 | `backend/src/routes/files.ts` | ~1518 | `GET /api/files`、`GET /api/files/stats`、`GET /api/files/:id` |
| 附件路由 | `backend/src/routes/attachments-core.ts` | ~1797 | `GET /api/attachments/:id`（下载/预览）、上传 |
| 附件存储 | `backend/src/services/attachment-storage.ts` | ~694 | 文件读写、对象存储、去重 |
| 缩略图服务 | `backend/src/services/thumbnails.ts` | - | sharp 缩略图生成与缓存 |
| 媒体分析 | `backend/src/services/modern-media.ts` | ~155 | Live Photo 分析、ffmpeg 视频处理 |
| 公开地址 | `backend/src/lib/file-public-origin.ts` | ~120 | 公开链接域名配置管理 |
| 数据库 Schema | `backend/src/db/schema.ts` | ~1263 | `attachments` 表定义 |

## 附录 B：MIME 类型分类映射表

```typescript
// backend/src/lib/mime-category.ts（新建）

export type MimeCategory = "image" | "video" | "audio" | "doc" | "other";

const IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml",
  "image/bmp", "image/avif", "image/heic", "image/heif", "image/x-icon",
  "image/vnd.microsoft.icon", "image/tiff",
]);

const VIDEO_MIMES = new Set([
  "video/mp4", "video/webm", "video/quicktime", "video/x-m4v",
  "video/ogg", "video/x-msvideo", "video/x-matroska",
]);

const AUDIO_MIMES = new Set([
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac",
  "audio/mp4", "audio/opus", "audio/amr", "audio/x-m4a",
]);

const DOC_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/markdown", "text/plain", "text/html",
  "application/zip", "application/x-zip-compressed", "application/gzip",
  "application/x-rar-compressed", "application/x-7z-compressed",
  "application/json", "application/xml",
  "text/csv",
]);

export function getMimeCategory(mime: string | null | undefined): MimeCategory {
  if (!mime) return "other";
  const lower = mime.toLowerCase();
  if (IMAGE_MIMES.has(lower)) return "image";
  if (VIDEO_MIMES.has(lower)) return "video";
  if (AUDIO_MIMES.has(lower)) return "audio";
  if (DOC_MIMES.has(lower)) return "doc";
  // 前缀兜底
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("audio/")) return "audio";
  if (lower.startsWith("text/")) return "doc";
  return "other";
}
```

## 附录 C：前端类型 Chips 定义参考

```typescript
// frontend/src/features/files/filesUi.ts（变更后）

export const UNIFIED_MIME_CHIPS: Array<{
  key: string;
  label: string;
  mimeCategory: MimeCategory | "all";
  icon: string;
}> = [
  { key: "all", label: "全部", mimeCategory: "all", icon: "grid" },
  { key: "image", label: "图片", mimeCategory: "image", icon: "image" },
  { key: "video", label: "视频", mimeCategory: "video", icon: "video" },
  { key: "audio", label: "音频", mimeCategory: "audio", icon: "music" },
  { key: "doc", label: "文档", mimeCategory: "doc", icon: "file-text" },
  { key: "other", label: "其他", mimeCategory: "other", icon: "file" },
];
```
