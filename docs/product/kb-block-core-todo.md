# kb-block-core 分支待办清单（交接文档）

> 给下一个 agent：先读 `docs/product/kb-block-core-plan.md`（方案与评审结论），再看本文件。
> 最高纪律：**改完代码禁止自动 commit**——agent 改完并确认能启动 → 用户测试确认 → 用户同意后才 commit。
> dev 必须从根目录 `npm run dev`（Electron 内置 Node ABI 130）；禁止在 backend/ 直接 npm run dev。
> 批量文本操作禁用 PowerShell -replace/Set-Content（大小写不敏感 + BOM 污染），用 Node 脚本。
> 大批量改动后删除所有 tsbuildinfo 缓存再 tsc 全量检查（增量缓存会假通过）。
> 查调试数据库用：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <script.cjs>`（better-sqlite3 是 ABI 130，系统 Node 装不上）。

## 当前状态（2026-10-24，四阶段全部完成）

分支 `feat/kb-block-core`，已完成并提交：
- 方案文档 `docs/product/kb-block-core-plan.md`（含评审结论：Excalidraw 选型、纯文本极简、PDF 保原件+批注层、匿名文档机制）
- 阶段 1 纯文本文档（plain 四件套：后端格式/创建/搜索 + PlainTextEditor + 知识树入口）
- UX 修复：导图/表格树节点点击深链 + 语义图标；+菜单创建后进入重命名；恢复历史版本编辑器立即刷新（contentRevision key 重挂载）
- UX 修复（2026-10-24）：知识库默认全折叠；关闭"打开的编辑器"后清空 activeNote/URL；匿名文档编辑器补"返回来源笔记"入口
- 匿名文档机制（迁移 130 + 前端插块/升级链路）已提交（5f2014a3）；UX 修复单独提交（f803e854）
- **思维导图归一知识库文档**（迁移 131，cc9d4009）——详见下方待办 2
- **阶段 3 Word 导入即正文**（c09be9c5）：DocxIR→Tiptap 适配器（IR 优先 + mammoth 兜底）+ 原件存附件 + 降级报告——详见下方待办 3
- **阶段 4 PDF 保原件 + 批注层**（b443e1f9）：contentFormat pdf + 受控分页查看器 + 页码锚定批注——详见下方待办 4

**plan 四阶段（1 纯文本 / 2 画板+匿名+导图归一 / 3 Word / 4 PDF）全部落地，等用户整体测试。**

## 环境备忘（2026-10-24，WSL）
- 本仓库在 WSL 里是软链：`/home/wushu/workspace/Base-Notes -> /home/wushu/workspace/BaseForge`
- backend 测试必须用 Electron 内置 Node：`cd backend && ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/electron --import tsx --import ./tests/setup-db-isolation.ts --test tests/xxx.test.ts`
- `npm run test:serial` 在本 WSL 环境不可用（脚本 spawn 系统 node，ABI 127 与 Electron ABI 130 的 better-sqlite3 不匹配，约 3/4 文件假失败）；验证用上面的逐文件方式
- HEAD 上既有失败（2026-10-24 用 stash 对比确认，与导图归一无关）：
  - backend：`attachment-cache-contract`、`attachment-modern-media`、`note-transfer`、`note-transfer-hardening`、`openapi-content-format`、`siyuan-issue-284-regression`（其余 249 文件全过，含新增 `mindmap-docs-migration` 2 项）
  - frontend：`releaseI18nCoverage`（缺 sidebarNext.* 键）、`androidNativeHttpBridge`（jsdom blob.arrayBuffer）、`EditorPaneNativeMarkdownCollab`、`PublicNotebookReadOnlyPermissions`；`cryptoV2` 满载偶发、单跑通过
- git 身份已配置到仓库级（wushuzhilu）

## 待办（按优先级）

### 1. 阶段 2：画板文档（本期核心，方案见 plan 阶段 2）
- [x] 安装 excalidraw（`@excalidraw/excalidraw@0.18.1`；BoardCanvas 独立 chunk，BoardEditor 内 React.lazy 懒加载）
- [x] contentFormat 新增 `"board"`：SDK 类型 + 后端 knowledgeTreeCore/notes 路由 + openapi + 知识树图标/新建菜单（桌面 + 移动）
- [x] BoardEditor 编辑器（走 EditorPane 的 contentFormat 分支，未做 `/boards/:id` 独立路由；画板仍是知识库文档，和 sheets/mindmaps 的独立模块模型不同）
- [x] BlockEmbedExtension 加 `![[board:<id>]]` 解析 → BoardEmbedCard（只读态 `exportToSvg` 预览，点击"打开"进画板文档；Markdown 预览同管线）
- [x] 创建入口：富文本斜杠命令「嵌入画板」（知识树新建菜单已完成）；选择对话框由原 SheetEmbedInsertDialog 泛化为 KnowledgeDocEmbedDialog
- [x] 画板正文派生搜索文本：`noteBlocks.syncNoteBlocks` 必须对 board 提前返回，否则会被当成 Markdown 生成"整段 JSON"contentText（已修）

### 2. 匿名文档机制（插块即匿名、单独创建才有名，导图同步适用，方案 plan 阶段 2）
- [x] notes 表加 `isUnlisted` 标记（迁移 130；`schema.ts` 基线、sync outbox note payload、`sync/apply.ts` 已同步）
- [x] 知识树/列表/搜索查询过滤 unlisted=1（含 shared tree、移动端 bootstrap、AI 检索、反链、搜索）
- [x] 富文本插块（`![[board:]]` 新建）→ 自动创建匿名文档；块卡片提供"转为独立文档"（`POST /notes/:id/promote`）
- [x] 引用计数 GC：从所有 `isUnlisted=0` 的笔记沿 `board:` / `mindmap:` 引用做可达性遍历；宿主内容变化或永久删除时清扫，24h 宽限期
- [x] 匿名文档没有知识树/页签入口，编辑器抬头提供“返回来源笔记”（来源记录在 sessionStorage，刷新后仍可用）
- [x] **思维导图归一知识库文档**（用户 2026-10-23 新要求）已提交（cc9d4009，2026-10-24）：
  - 迁移 131（`db/mindmapDocsMigration.ts`）：活动+回收站导图全部迁为 notes 行（contentFormat="mindmap"，正文=MindMapData JSON），**沿用原 uuid**，`![[mindmap:<id>]]` 嵌入不失效；树节点由 notes 投影触发器重建为 `note:<id>`，parentId/sortOrder 对齐旧位置；回收站导图按 isTrashed=1 迁移（trash 展示/恢复走笔记链路）；迁移末尾清空 mindmaps 表并卸载导图树投影触发器
  - notebookId 映射：导图文件夹继续用伪 notebook 容器（`__nowen_mindmap_folder__:` 前缀的真实 notebooks 行）；无文件夹的挂靠自动创建的"思维导图"兜底笔记本（`services/mindmapDocs.ts`）
  - `/api/mindmaps` 保留为**门面路由**（SDK/移动端/嵌入卡片契约不变），读写全部落 notes：PUT 乐观锁（MINDMAP_CONFLICT 409）改锁 notes.updatedAt（毫秒精度）、star→isFavorite、move→伪 notebook、DELETE→树软删；插件 hostApiBroker 的 mindmaps get/list 同步门面化
  - 树/打开/创建：三处树实现（KnowledgeTreePanel/MobileKnowledgeTreePanel/SidebarDesktop）导图深链分支移除，导图文档按笔记打开；createKnowledgeChild 的 mindmap 分支改建 notes 行；图标判定（nodeIcons/SidebarDesktop fileIconFor）补 contentFormat="mindmap"
  - 编辑器：新增 `MindMapDocEditor`（包装 MindMapCenter embeddedMode，懒加载 chunk；MindMapCenter 补了 embeddedMode 卸载前冲刷防抖保存），EditorPane 按 contentFormat="mindmap" 分支渲染 + "导图"徽标；AI mermaid 存为导图后按笔记打开（不再 setViewMode）
  - 嵌入：KnowledgeDocEmbedDialog 增加 mindmap kind（新建即匿名 isUnlisted=1，同画板）；MindMapEmbedInsertDialog 删除；MindMapEmbedCard "打开"改为笔记打开 + 补"转为独立文档"（promote）
  - 搜索：导图专用搜索路径（search.ts fetchMindMapResults）改查 notes（resourceType 仍返回 mindmap 供 UI）；笔记搜索两条候选路径排除 contentFormat='mindmap' 防重复；searchIndex.normalizeContentFormat 放行 mindmap（健康检查/重建用派生文本）
  - 公共分享：快照收集（sharedMindMapSnapshots）改读 notes；PublicKnowledgeResourceRenderer 对 contentFormat="mindmap" 的笔记渲染静态快照
  - 移动端：同步链路零改动（bootstrap 继续导出 mindmaps 表→现在为空，mobileSyncEngine 的 removeMissing 会自动清掉本地旧导图行）；本地内联创建导图改为创建本地 notes（走笔记同步）
  - **保留的遗留痕迹**（刻意）：/mindmaps 路由 + viewMode "mindmaps" + MindMapCenter 模块列表页保留（2026-10-14 已从导航移除，现仅 URL 直连可达，兼容旧深链）；knowledgeTreeListing 的 mindmaps JOIN、sync 的 mindmap entityType 收发、mindmap-folders 路由保留（空表/无节点，无害）

### 3. 阶段 3：Word 导入即正文（方案 plan 阶段 3）——已完成（2026-10-24）
- [x] DocxIR→Tiptap JSON 适配器：`frontend/src/office/serializers/ir-to-tiptap.ts`（标题/行内标记/列表聚合/表格合并/图片上传，含降级清单记录；单测 8 项在 `src/office/__tests__/`）
- [x] 导入 .docx 生成 tiptap-json 笔记：`importDocxAsNote` 改为 **IR 管线优先、mammoth HTML 兜底**（损坏/极端格式静默回退）；原件 .docx 导入时同步存附件（失败不阻断，记 warning）
- [x] 复杂版式降级清单 + 导入报告：downgrades 并入 result.warnings，知识树导入入口 toast 逐项提示（截断 80 字）
- [x] "导出为 .docx"复用现有序列化（exportNoteAsDocx 此前已有，双向闭环成立）
- 备注：自研 IR 管线此前只用于预览（WordViewer），现在预览/导入/导出共用同一份 DocxIR；图片走 blob→fetch→附件上传，宽高 pt→px（×4/3）

### 4. 阶段 4：PDF 保原件 + 批注层（方案 plan 阶段 4，用户已认可）——已完成（2026-10-24）
- [x] contentFormat 新增 `"pdf"`：后端创建白名单/默认正文 `{attachmentId,annotations:[]}`、searchIndex 白名单、noteBlocks 派生批注文本、openapi/SDK 类型；正文 = 原件引用 + 页码锚定批注层 JSON（`lib/pdfAnnotations.ts` 后端 / `lib/pdfDocContent.ts` 前端，同构）
- [x] 查看器复用 AttachmentPdfPreview（pdfjs），扩展受控页码 props（page/onPageChange）；右侧批注层侧栏（PdfDocEditor：按页添加/编辑/删除批注、点击批注跳页、下载原文件），防抖走通用笔记保存
- [x] 导入入口：知识树 +菜单/创建菜单"导入 PDF 文档（保原件）"（桌面两处菜单 + 移动端面板），建笔记→传附件→回填引用→失败回收站回滚
- [x] 树图标：contentFormat="pdf" → 红色 FileText（nodeIcons + SidebarDesktop）；EditorPane"PDF"徽标
- 备注：批注为纯文本（不做富文本/选区摘录捕获，quote 字段模型已留）；批注文本进 contentText → 全文搜索可命中；未做 ![[pdf:]] 嵌入块（plan 验收未要求）

### 5. 小项（可选增强）——已完成（2026-10-24）
- [x] `.txt` 导入加"保持纯文本"选择：导入 Markdown 文件的文件选择器放行 .txt，选中 .txt 时弹选择框（纯文本 / 转 Markdown，默认 Markdown，取消也按 Markdown）；拖拽导入路径行为不变
- [x] 命令面板补"新建文档"命令组（富文本/Markdown/纯文本/画板/导图五项，目标 = 当前选中笔记本，创建后深链打开）

## 已知坑（前人教训）
- EditorPane 各编辑器只在 mount 时读 note.content：任何"外部改正文"的场景（版本恢复、AI 写入等）都需要 contentRevision key 重挂载机制（见 EditorPane onRestore）
- SidebarDesktop 有自己独立的知识树实现（openNode/fileIconFor/handleCreate），与 KnowledgeTreePanel/MobileKnowledgeTreePanel 三处并存——改树行为要三处对齐
- plain/plainTextFromNoteContent、searchIndex.normalizeContentFormat 已放行 "plain"/"board"/"mindmap"；新增格式值记得同步这两处 + SDK types + knowledgeTreeCore + notes.ts 创建路由 + capabilityCatalog（构建时生成）
- Excalidraw 的 onChange 也会随"空闲状态"等非场景 appState 变化触发；BoardEditor 已加"内容未变化不排队保存"的守卫，去掉会变成每秒一次无效 PUT + 版本膨胀
- 新增 contentFormat 后必须检查 `noteBlocks.syncNoteBlocks`（保存链路会在事务后再次覆盖 contentText）与 `searchIndex.normalizeContentFormat`，只改 `extractSearchableText` 不够
- 归一后的导图文档与笔记搜索：笔记候选查询必须排除 contentFormat='mindmap'，否则全局搜索同一篇导图会在"文档"和"脑图"两个分区重复出现
- 迁移 131 依赖两个前置：notes 树投影触发器（knowledgeTreeMigrationCore）必须已安装（v104 前就有）；导图文件夹伪 notebook（v105）必须已投影——顺序由版本号排序保证
- `sync/engine.ts` / `mobileSyncEngine.ts` 的 removeMissing("mindmaps") 意味着 **bootstrap 必须继续导出 mindmaps 表**，否则同步会把各端本地导图行全删；现在表为空是预期状态，别"清理"这段导出
- 门面 PUT 用毫秒精度 updatedAt（strftime %f）参与乐观锁，与 notes 其他写入的秒级 datetime('now') 混存，字典序比较仍正确，别改成统一秒级（会破坏 MINDMAP_CONFLICT 的同秒判冲突）
- 匿名导图文档（isUnlisted=1）必须允许 `GET /api/mindmaps/:id` 读取（嵌入卡片唯一入口），匿名文档 GC（anonymousDocuments.ts）已同时提取 board|mindmap: 引用
- wiki 嵌入（`![[mindmap:|board:]]`）只有正式预览/分屏走 MarkdownPreview 才渲染卡片；Markdown 的「实时预览」(cm inline) 仍显示原文，与 mindmap 行为一致
- 画板嵌入预览用 `exportToSvg(..., skipInliningFonts: true)`，字体依赖随 chunk 加载的 @font-face，不要在导出后删掉这份 CSS
- 匿名文档没有知识树节点，但 `knowledgeCapabilityProjectionRepair` 会在权限解析时把缺失节点补回来——必须在 `repairKnowledgeResourceProjectionIfStale` 里对 `isUnlisted=1` 直接返回，否则匿名文档会"自己长回"知识树
- 匿名文档 GC 有 24h 宽限期：删除嵌入块后不会立刻回收；测试要回填 `createdAt` 到 2 天前。清扫触发点是宿主内容 PUT 与永久删除（`notes.ts` 和 `trash/noteTrashAdapter.ts` 两条删除链路）
- SQLite `datetime('now')` 返回的 `createdAt` 没有时区标记，`new Date(str)` 会按本地时间解析；匿名文档宽限期判断需补 `Z`（服务内 `parseSqliteTimestamp`）
- `notes.notebookId` 非空：匿名文档必须复用宿主笔记的 notebookId，不能为它单独建 notebook
- EditorPaneCore 会随 activeNote.id 改变重挂载（`EncryptedConversionEditorGuard` 的 `EditorLease key=[scope,noteId]`），跨笔记的状态不能放组件内 ref；「匿名文档返回来源」用 sessionStorage
- Electron 不支持 `window.prompt`：「转为独立文档」用卡片内联命名输入，不要换成 prompt
- 新增 `notes` 列时别漏三处同步白名单：`syncOutboxCaptureMigration` 的 note payload、`sync/apply.ts`、`sync/applyLocal.ts`；`sync/bootstrap.ts` 的 `readLocalState` 也要带新列，否则新设备上匿名文档会以 `isUnlisted=0` 落库。迁移末尾要重装捕获触发器
