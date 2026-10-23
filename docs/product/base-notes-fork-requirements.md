# BaseForge 分叉产品需求整理

> 状态：**需求起草稿 v0.1（待用户评审）**
>  작성日期：2026-10-17
> 基线：从 nowen-note 分叉（BaseForge `1.0.0-preview.1`，代码基线 nowen-note v1.4.16 + 已吸收 v1.5.1）
> 本文是长期任务的**需求基线文档**，后续原型设计与代码编写以本文为准；本文只记录"要做什么"，不记录"怎么做"。

---

## 0. 这份文档怎么用

- 第 1 节是产品判断，写清楚我们和上游 nowen-note 的分工与差异，是后续所有需求的出发点。
- 第 2 节是**现有资产盘点**（全部结论来自当前代码，标注了文件位置），避免重复造轮子，也是判断"新增/改造/删除"的依据。
- 第 3 节是**功能需求本体**，按主题拆分，每条需求有编号（如 `FR-DOC-01`），便于后续原型和任务拆解引用。
- 第 4 节明确**非目标**，防止范围膨胀。
- 第 5 节是**待决策问题**，标注了影响和默认倾向，用户确认后再进入原型阶段。

需求编号规则：`FR-<主题>-<序号>`。主题见第 3 节标题。

---

## 1. 产品定位与分叉策略

### 1.1 一句话定位

**BaseForge = 以知识库为核心的个人/团队知识基础设施，形态对标语雀，扩展模式对标 VS Code，数据与部署完全自持。**

三个不可让渡的支柱：

| 支柱 | 含义 | 上游 nowen-note 的关系 |
|---|---|---|
| 知识库优先 | 一切内容（含表格、导图、画板、任务、日记）都是知识库里的资源，由一个统一树组织 | 上游已有知识树雏形，但仍是"笔记优先" |
| 块核心 | 富文本是第一等公民，其他文档形态以"块"插入富文本，块与文档双向互通 | 上游已有 Block Embed 雏形 |
| 插件生态 | 非核心功能全部插件化，可安装/可关闭；远程存储、项目管理、论坛等均以插件形态生长 | 上游已有插件平台雏形，但贡献点极少 |

### 1.2 分叉策略

- **保留**：上游的多端架构（Web / Electron / Android / iOS / Harmony）、Yjs 同步引擎、加密体系、工作区与权限、备份恢复、导入导出。这些是重资产，不要推倒。
- **改造**：导航与信息架构（知识库优先）、文档类型体系（块化）、插件贡献点体系（VS Code 化）、AI 接线方式。
- **新增**：画板文档、纯文本文档、PDF/Word 一等文档、插件化模块容器、论坛/广场类插件样板。
- **降级**：待办、小记/每日记录等当前与"笔记"平级的模块，改为插件形态，默认可关闭。

### 1.3 与现有 `feat/new_plane` 分支的关系（需用户确认）

远端 `origin/feat/new_plane` 已 Universal 了"知识库优先 IA"的侧栏改造：Rail 改为 VS Code 式活动栏、侧栏面板容器（`frontend/src/components/sidebar/panels/*`）、工具页签系统（`frontend/src/lib/toolPage.ts`、"附件"改名等），并且已经在 SDK 契约里加了 `sidebarPanels` / `activityBadges` 两类插件贡献点（`packages/nowen-plugin-sdk`，契约 v5）——但契约文档明确写了"宿主运行链路由主线后续接线，接线完成前不生效"。

**这恰好是本需求第 3.4 节（插件化）想要的宿主框架。** 建议把 `feat/new_plane` 的侧栏/面板/页签框架作为本分叉的开发基线，而不是从 main 重新造。见待决策问题 Q1。

---

## 2. 现有资产盘点（代码事实）

> 结论用于判断"新增/改造/删除"。所有条目已在当前 `main`（653b4188）核对。

### 2.1 已经有的（直接继承或小改）

| 能力 | 现状 | 关键位置 |
|---|---|---|
| 统一知识树 | 节点类型 `folder / note / markdown / word / mindmap / file`，资源类型 `notebook / note / mindmap / file`；支持根目录文档、无限层级、拖拽排序、密码保护、目录 ACL | `frontend/src/lib/knowledgeTreeApi.ts`、`backend/src/services/knowledgeTree*.ts` |
| 富文本编辑器 | Tiptap 3 StarterKit + 表格/代码块/高亮/Callout/分栏/任务列表/表情/脚注/数学/图片/视频/块嵌入；斜杠命令面板；块柄菜单（复制/粘贴/拖动/缩进/转化） | `frontend/src/components/TiptapEditor.tsx`、`SlashCommands.tsx`、`extensions/` |
| Markdown 编辑器 | CodeMirror 6，实时预览/分屏，可与富文本互转（MD↔Tiptap 有完整切换协议） | `frontend/src/components/MarkdownEditorImpl.tsx`、`docs/editor-mode-switch.md` |
| 轻量表格文档 | `sheets` 独立表（`noteId` 主键 + JSON 数据），SheetEditor 支持排序/筛选/列宽/对齐/类型，XLSX/CSV 导入导出 | `frontend/src/components/SheetEditor.tsx`、`frontend/src/lib/sheetModel.ts` |
| 思维导图文档 | 自研 DOM+SVG 混合渲染（非三方库），支持缩放/平移/框选/拖拽/标记/关系线/概览/Xmind 导出/深链 | `frontend/src/components/MindMapEditor.tsx`、`backend/src/db/knowledgeTreeResourceMigration.ts` |
| 块嵌入（文档⇆块互通） | 已有 `![[note:id#blk:…]]`、`![[mindmap:id]]`、`![[sheet:id]]` 三种引用，嵌入卡片懒加载 | `frontend/src/components/BlockEmbedExtension.tsx` |
| 任务与习惯 | 树形/列表/看板/日历/甘特、依赖、重复、提醒、模板、My Day、Inbox、移动端原生提醒 | `frontend/src/components/tasks/`、`backend/src/routes/tasks*.ts` |
| 每日记录/日记/瞬间 | DailyRecordsHub（瞬间/日历/日记三个页签）、AI 周报月报、工作区共享日记 | `frontend/src/components/daily-records/`、`DiaryCenterImpl.tsx` |
| AI 接入 | OpenAI 兼容 / 通义 / Gemini / DeepSeek / 豆包 / Ollama；多 Profile 切换；续写/改写/翻译/总结/标题标签生成；RAG 知识问答（sqlite 向量索引 + 附件分块检索）；语音转写 | `backend/src/routes/ai.ts`、`services/vec-store.ts`、`frontend/src/components/AIChatPanel.tsx` |
| 插件平台 | manifest apiVersion 2；三种运行时（`sandbox-js` / `node-action` / `declarative`）；权限模型、签名与信任根、Registry 市场（内置信任根 + 自定义源）、插件更新 Coordinator、Plugin Studio | `backend/src/plugins/*`、`frontend/src/components/settings/plugins/` |
| 插件贡献点 | 现有：commands / menus / settings / automationTemplates / noteThemes / noteTemplates / promptPacks / uiComponents / inboundWebhooks。UI 贡献点目前只有一种：向 `floating-layer` 插一个"跳转到某视图"的按钮 | `backend/src/plugins/types.ts:192`、`frontend/src/lib/pluginUiRegistry.ts` |
| 实时协作 | Yjs + WebSocket，note 级协同，Y.Doc 持久化确认 | `backend/src/services/yjs.ts`、`sync/` |
| 工作区与权限 | 工作区/成员/邀请、角色预设、目录 ACL、Restricted 模式、权限继承、所有权转移 | `backend/src/services/knowledgeCapabilities*.ts`、`routes/workspaces.ts` |
| 分享与公开空间 | 分享链接（密码/有效期/访客评论）、公开知识库浏览、公开资源渲染器（已支持导图/表格/富文本） | `PublicNotebookView.tsx`、`notebookPublicationApi.ts` |
| 导入 | Markdown / Word(DOCX) / 网页 URL / 公众号 / SingleFile HTML / 思源 / Obsidian / 小米 / OPPO / vivo / **语雀** | `backend/src/routes/*.ts`、`frontend/src/office/` |
| 附件与预览 | 本地/S3/R2/MinIO；PDF(pdfjs) / DOCX(mammoth) / XLSX(自研解析) / 文本 预览；缩略图、孤儿清理 | `frontend/src/components/attachmentPreview/` |
| 备份恢复 | 本地自动备份、完整 ZIP 后台任务、邮件备份、WebDAV 远程备份、Docker 升级前备份 | `backend/src/services/backup*.ts` |
| 开放能力 | OpenAPI 3.0、TS SDK、CLI、Personal API Token、MCP Server、浏览器剪藏扩展 | `packages/*` |
| 工作区工单 | `workspace_issues` 表，issue + 评论 + 活动流，可关联笔记 | `frontend/src/components/issues/WorkspaceIssues.tsx` |

### 2.2 部分有的（需要改造才能满足需求）

| 能力 | 缺口 |
|---|---|
| **导航架构** | `ViewMode` 是扁平的十几种字符串（`"all"｜"tasks"｜"diary"｜"mindmaps"｜"files"…`，见 `frontend/src/types/index.ts:263`），模块与文档平级；`App.tsx` 用一长串三元表达式切换主区域。新需求要求"知识库为中心，其他都是插件/侧面板"，这块必须重构成注册表驱动。 |
| **模块开关** | 现有 `WorkspaceFeatures`（notes/diaries/tasks/mindmaps/files/favorites）是**工作区级**布尔开关，不是全局插件式开关，且只覆盖 5 个模块。 |
| **插件 UI 贡献点** | 只能往悬浮层放一个跳转按钮；不能贡献侧栏面板、工具页签、文档类型、编辑器块。`feat/new_plane` 已在 SDK 契约加了 `sidebarPanels`/`activityBadges`，但宿主未接线。 |
| **表格/导图作为块** | 目前是"整篇文档嵌入"（`![[sheet:id]]` 只引用文档 id，没有块级 id/区域引用），且表格块⇄表格文档只是单向展示互通。 |
| **插件平台开关** | `featureFlags.ts` 里插件 v2.1 全链路 fail-closed（默认全关，需 `NOWEN_EXTENSIONS_V21` 等环境变量）。作为产品级卖点，需要"开箱可装的稳定插件面"。 |
| **Word/PDF 文档** | 目前 DOCX 只能"导入转富文本/Markdown"，PDF 只是附件可预览。没有"作为文档打开并保持格式"的形态。 |

### 2.3 完全没有的（需要新建）

| 能力 | 说明 |
|---|---|
| 画板（白板）文档 | 无任何 canvas 画图依赖（无 excalidraw/tldraw/fabric/konva），MindMapEditor 的手写 SVG 导出是唯一相关经验 |
| 纯文本文档 | 无 `.txt` 一等文档类型（txt 只在附件/导入层出现） |
| 类型注册表 | 没有"文档类型"中心注册机制（现有是硬编码 kind 联合类型 + `App.tsx` 三元路由） |
| 插件模块容器 | 没有"插件提供一个完整模块页（含侧栏面板 + 工具页 + 设置页）"的机制 |
| 广场/论坛 | 无任何社区内容模块（公开知识库是只读浏览，不是论坛） |
| 远程文档源（百度云/WebDAV/SMB） | 备份有 WebDAV，但"把远程存储挂成文档树"没有 |

---

## 3. 功能需求

### 3.1 核心信息架构：知识库优先（FR-IA）

> 对标：语雀的空间/知识库结构；VS Code 的活动栏 + 侧栏面板 + 主区页签。

- **FR-IA-01 唯一内容树**：所有文档与文件夹在一个树内组织，不再有"笔记列表 / 导图中心 / 表格中心"这类与知识库平级的入口。导图中心已从主导航移除（main 分支已完成），表格等后续同类处理。
- **FR-IA-02 活动栏（Activity Bar）**：左侧活动栏承载"跨树筛选 + 独立模块"入口，形态参考 `feat/new_plane` 已实现的 `sidebarPanels` 框架。
- **FR-IA-03 侧栏面板容器**：收藏、附件、标签、回收站、打开编辑器等沉淀为可折叠/可排序/可隐藏的面板（宿主已有 `SidebarPanelShell` 雏形）。
- **FR-IA-04 主区页签**：文档以页签形式打开，支持多开、keepAlive、工具页与文档页混排（宿主已有 `ToolPageHost` / `toolPage.ts` 契约）。
- **FR-IA-05 模块即面板/页签**：待办、每日记录、AI 对话等从"顶级 viewMode"降级为"活动栏图标 → 侧栏面板或工具页"。
- **FR-IA-06 全局搜索**：跨文档类型（富文本/Markdown/表格/导图/画板/纯文本/附件）统一检索，支持按类型筛选。

### 3.2 文档类型体系（FR-DOC）

> 对标：语雀的文档/表格/画板/思维导图/上传文件。

- **FR-DOC-01 文档类型矩阵**：产品内至少支持以下类型，全部是一等公民（可创建、可重命名、可移动、可分享、可搜索、可权限控制）：

  | 类型 | 存储形态（现状） | 目标 |
  |---|---|---|
  | 富文本文档 | `notes.content` = Tiptap JSON | 保持，作为块容器核心 |
  | Markdown 文档 | `notes.content` = markdown 文本 | 保持 |
  | 轻量表格文档 | `sheets` 表 + JSON | 保持，补块级嵌入 |
  | 思维导图文档 | `mindmaps` 表 + JSON | 保持 |
  | 画板文档 | — | **新建** |
  | 纯文本文档 | — | **新建**（`.txt`，CodeMirror 纯文本模式） |
  | PDF 文档 | 附件预览 | **新建**"PDF 文档"类型，打开为阅读视图，支持批注 |
  | Word 文档 | 仅导入转换 | **新建**"Word 文档"类型，保持原始格式打开（避免转换损失） |

- **FR-DOC-02 文档类型注册表**：建立中心化的类型注册机制（id、名称、图标、创建入口、打开路由、搜索索引器、嵌入卡片渲染器），替代现有硬编码 kind 联合类型。
- **FR-DOC-03 统一创建入口**：知识树右键/"+"菜单按注册表列出全部可用类型；类型可由插件注册（见 FR-PLG-03）。
- **FR-DOC-04 文件类文档兜底**：未识别/不希望转换的格式（PPT、Excel 原文件、压缩包等）以"文件文档"形态挂在树上，点击走系统默认程序或内置预览，不强行转格式。
- **FR-DOC-05 导入为指定类型**：导入 Word/PDF/Markdown 时可选"转为富文本""转为 Markdown""保留原格式"。

### 3.3 块核心富文本增强（FR-BLK）

> 对标：Notion / 语雀的块模型，以及上游已启动的 Block 权威存储方向。

- **FR-BLK-01 块类型全集**：标题、正文、列表（有序/无序/任务）、引用、Callout、代码块、数学公式、表格、图片、视频、音频、附件、分割线、折叠块、分栏、高亮块（现有）；新增：**画板块、PDF 块、附件文档块、AI 生成块、日期/提醒块**。
- **FR-BLK-02 画板作为块**：画板可以整篇嵌入富文本（`![[canvas:id]]`），也可以块级嵌入局部区域。
- **FR-BLK-03 表格作为块**：轻量表格支持区域级嵌入（嵌入指定行列范围，而非整篇引用），嵌入后可原地编辑并回写源表格。
- **FR-BLK-04 导图作为块**：现有 `![[mindmap:id]]` 补齐方向：嵌入卡片支持折叠/展开预览、块级定位高亮。
- **FR-BLK-05 块级引用与反向链接**：任意块可被引用（现有 `note:id#blk:xxx` 已实现），补齐画板/PDF/表格子块的引用 id 体系与反向链接面板。
- **FR-BLK-06 块级权限与加密**：延续上游加密笔记/加密块能力，块级加密与文档级加密一致可用。
- **FR-BLK-07 块拖拽与分栏交互**：保持上游已有交互（块柄菜单、拖拽、分栏调宽），新块类型必须接入同一套交互。

### 3.4 插件化架构（FR-PLG）

> 对标：VS Code 扩展（贡献点 + 命令 + 设置 + 视图容器 + Webview）。

- **FR-PLG-01 插件 CLI 稳定面**：默认提供一组**开箱可用**的官方插件类型（主题、模板、提示词包、导出格式、剪藏规则、存储后端），不需要环境变量手动开启。
- **FR-PLG-02 插件管理器**：统一 UI（安装/卸载/启用/禁用/更新/权限授予/日志）；支持多个 Registry 源与信任级别展示（宿主已有雏形）。
- **FR-PLG-03 插件可注册文档类型**：插件通过 `contributes.documentTypes` 注册新文档类型（如 "drawio 图""看板文档"），宿主负责创建入口、打开路由、树图标、搜索索引。
- **FR-PLG-04 插件可注册编辑器块**：插件通过 `contributes.blockTypes` 注册富文本块节点（React NodeView 或声明式渲染）。
- **FR-PLG-05 插件可注册侧栏面板与工具页**：接线 `feat/new_plane` 已定义的 `sidebarPanels` / `activityBadges` 契约到宿主渲染链路。
- **FR-PLG-06 插件可注册命令与菜单**：命令进入命令面板（宿主已有 `CommandPalette`），菜单可插入指定位置（树右键、编辑器选区菜单、工具栏）。
- **FR-PLG-07 插件可注册远程文档源**：插件提供"文档源提供者"接口，把 WebDAV / SMB / 百度云 / 阿里云盘 / GitHub 仓库等挂载为知识树的虚拟子树（只读或可写）。
- **FR-PLG-08 插件沙箱与权限**：延续现有沙箱运行时 + 权限模型；敏感能力（网络、文件、密钥）走显式授权与审计日志。
- **FR-PLG-09 插件不改变核心**：卸载任何官方插件后，核心知识库 + 富文本 + 搜索仍完整可用。

### 3.5 非重点功能插件化（FR-MOD）

> 用户明确要求："将现有的待办、小记等非重点功能作为插件，可以关闭。"

- **FR-MOD-01 插件化改造**：待办（任务中心）、小记/每日记录（瞬间/日记）改造为官方插件，通过插件管理器可整体停用；停用后活动栏图标消失、API 路由不再注册、树内不出现相关节点。
- **FR-MOD-02 数据保留**：停用不删除数据；重新启用后数据恢复可见。
- **FR-MOD-03 判定标准**："非重点功能" = 移除后不损害"写文档、管知识、查知识"主链路的模块。待办、每日记录、习惯、工单、分享管理符合此标准；AI、搜索、导入导出不符合。
- **FR-MOD-04 保留增强**：待办与小记虽降级为插件，但保持现有功能完整（任务有依赖/甘特/提醒，小记有瞬间/日历/日记/AI 周报），不做功能删减。

### 3.6 AI 能力保留与增强（FR-AI）

> 用户明确要求："保留并增强现有 ai 接入功能。"

- **FR-AI-01 保留现状**：多 Provider、多 Profile、RAG 问答（知识库/当前笔记/选中文本三种 scope）、续写改写翻译总结、Embedding 索引、语音转写全部保留。
- **FR-AI-02 知识库级 AI**：AI 上下文范围扩展到全部文档类型（表格单元格、导图节点文本、画板 OCR/文本、PDF 分块），反向链接面板显示 AI 引用来源。
- **FR-AI-03 AI 作为块**：AI 生成内容以块形态沉淀在文档里（可重新生成、可对比版本），而不是只在聊天面板。
- **FR-AI-04 AI 草稿与引用**：AI 输出插入文档时保留来源标注（哪几篇文档/附件）。
- **FR-AI-05 MCP 增强**：现有 MCP Server 扩展操作面（创建文档、操作块、操作表格/导图），让外部 AI 客户端能直接驱动知识库。
- **FR-AI-06 提供商插件化**：AI 提供商配置可做成插件贡献（如新增"硅基流动""OpenRouter"提供商），核心只保留 OpenAI 兼容协议。

### 3.7 远程与系统集成（FR-REM，插件方向）

- **FR-REM-01 远程文档源插件样板**：优先实现 WebDAV 源（备份已有 WebDAV 客户端可复用）、SMB 源；百度云/阿里云盘视授权可行性排期。
- **FR-REM-02 Git 集成插件**：把仓库/工单（GitHub/Gitea Issue）拉进知识库侧栏面板，支持从文档创建 issue（现有 `workspace_issues` 可作为本地工单底座）。
- **FR-REM-03 项目管理插件样板**：以任务插件 + Git 插件 + 文档为骨架，演示"BaseForge 成为管理系统一环"的路径。

### 3.8 社区/广场（FR-HUB）

- **FR-HUB-01 广场插件（远期）**：类 CSDN 论坛形态——帖子、分类、评论、点赞；与知识库打通（帖子可引用/导出为文档，文档可发布为帖子）。
- **FR-HUB-02 发布边界**：公开知识库（现有只读浏览）作为广场的轻量替代先行落地；广场作为独立官方插件，默认关闭。
- **FR-HUB-03 内容治理**：发帖审核/举报/敏感词、用户封禁、内容版式审计，需在插件设计时一并考虑（涉及自托管合规）。

---

## 4. 非目标（明确不做）

- **不做**SaaS 化改造：保持自托管优先，账号体系延续现有本地/服务器模式。
- **不做** substituting 上游同步引擎 / 加密体系 / 备份体系的推倒重写。
- **不做**实时协同编辑的替代实现：继续 Yjs。
- **不承诺**百度云/阿里云盘的官方 API 集成：若无开放接口或授权成本过高，则以 WebDAV/SMB/本地挂载替代。
- **不做**移动端全功能对齐优先：插件化改造先桌面端与 Web，移动端后续跟进。
- **不追求**与 Notion/语雀的数据格式互通：已有语雀/思源/Obsidian 导入足够，不做导出到这些平台。

---

## 5. 待用户决策的问题

> 以下问题会显著影响原型与首批代码。给出默认倾向，用户否决再改。

| # | 问题 | 影响 | 默认倾向 |
|---|---|---|---|
| Q1 | 是否以 `origin/feat/new_plane`（侧栏/面板/页签框架 + 契约 v5）为开发基线，而不是 `main`？ | 决定是否重做导航重构 | **是**。该分支的方向与本次需求高度一致，基线复用可省掉大工作量 |
| Q2 | "小记"具体指哪个模块？（每日记录"瞬间"、日记、还是另一个快速捕获入口？） | 决定插件化改造对象 | 倾向指**每日记录中心（瞬间/日记）**整体，但需确认 |
| Q3 | 待办是否真的要降级为插件，而不是保留在活动栏？ | 用户原话是"待办、小记等作为插件可关闭"，但待办功能量很大（甘特/依赖/提醒） | 倾向**改造为默认启用的官方插件**，可关闭但默认装 |
| Q4 | PDF/Word 作为"一等文档"的边界：只要求"打开+阅读+批注"，还是要求"编辑保存"? | 决定是否需要完整 Office 编辑内核 | 倾向**阅读 + 批注 + 局部文本选择**，不做完整编辑（避免巨大工作量） |
| Q5 | 画板的技术形态：自研 SVG/DOM（延续导图经验）还是引入成熟库（excalidraw 内核/tldraw）? | 决定开发量与可控性 | 倾向**引入成熟内核**（工作量可控、生态成熟），自研作为降级方案 |
| Q6 | 广场/论坛的部署形态：单实例自托管社区，还是联邦/多实例？ | 决定数据模型复杂度 | 倾向**单实例社区**，先满足"自托管小圈子" |
| Q7 | 插件生态的开放程度：是否允许第三方 Registry 与商业插件？ | 决定签名/审核策略 | 倾向**允许自定义 Registry + 明确信任级别**，官方 Registry 默认内置 |
| Q8 | 版本与分叉节奏：BaseForge 版本线如何演进？现有 `1.0.0-preview.1` | 决定发版与 CHANGELOG 策略 | 倾向保持独立版本线，本需求作为 `1.0.0` 正式版目标集 |

---

## 6. 里程碑建议（粗排，评审后细化）

| 阶段 | 主题 | 出口标准 |
|---|---|---|
| M0 | 需求评审 + 基线选择 | 本文评审通过；确认 Q1~Q8 |
| M1 | 信息架构改造（知识库优先 + 模块面板化） | 活动栏/侧栏面板/工具页框架落地；待办/小记/AI 迁移为面板或页签 |
| M2 | 文档类型体系 + 纯文本/画板/PDF 文档 | 类型注册表落地；新类型可创建/打开/分享/搜索 |
| M3 | 块核心增强 | 画板/表格/导图/PDF 均可作为块插入，块级引用与反向链接可用 |
| M4 | 插件平台升级 | 文档类型/块/侧栏面板/命令菜单贡献点可用；官方插件管理器开箱可用 |
| M5 | 官方插件化改造 | 待办、小记可关闭；数据保留 |
| M6 | AI 增强 + MCP | AI 覆盖全部文档类型；MCP 可驱动文档与块 |
| M7 | 远程集成与社区 | WebDAV/SMB 源插件；Git 工单插件；广场插件样板 |

---

## 附录 A：术语表

| 术语 | 含义 |
|---|---|
| 知识库 | 本产品中"一棵树组织的全部内容"的统称，对应上游 notebook/知识树概念 |
| 文档 | 树上的一个可打开节点（富文本/Markdown/表格/导图/画板/纯文本/PDF/Word） |
| 块 | 富文本内的最小内容单元，也指可嵌入文档的引用单元 |
| 贡献点 | 插件向宿主注册功能的契约声明（contributes） |
| 工具页 | 主区中非文档的独立页面（任务中心、AI 对话等） |
| 模块 | 可由插件提供并可整体停用的功能集合 |

## 附录 B：本文档的维护方式

- 需求变更直接改本文（不要新开文件），保持单一基线。
- 每次评审在文首"状态"行更新版本与日期。
- 进入原型/开发阶段后，具体设计写在 `docs/superpowers/specs/<日期>-<主题>-design.md`，实施计划写在 `docs/superpowers/plans/<日期>-<主题>.md`，与上游现有约定一致。
