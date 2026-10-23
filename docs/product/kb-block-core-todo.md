# kb-block-core 分支待办清单（交接文档）

> 给下一个 agent：先读 `docs/product/kb-block-core-plan.md`（方案与评审结论），再看本文件。
> 最高纪律：**改完代码禁止自动 commit**——agent 改完并确认能启动 → 用户测试确认 → 用户同意后才 commit。
> dev 必须从根目录 `npm run dev`（Electron 内置 Node ABI 130）；禁止在 backend/ 直接 npm run dev。
> 批量文本操作禁用 PowerShell -replace/Set-Content（大小写不敏感 + BOM 污染），用 Node 脚本。
> 大批量改动后删除所有 tsbuildinfo 缓存再 tsc 全量检查（增量缓存会假通过）。
> 查调试数据库用：`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <script.cjs>`（better-sqlite3 是 ABI 130，系统 Node 装不上）。

## 当前状态（2026-10-23）

分支 `feat/kb-block-core`，已完成并提交：
- 方案文档 `docs/product/kb-block-core-plan.md`（含评审结论：Excalidraw 选型、纯文本极简、PDF 保原件+批注层、匿名文档机制）
- 阶段 1 纯文本文档（plain 四件套：后端格式/创建/搜索 + PlainTextEditor + 知识树入口）
- UX 修复：导图/表格树节点点击深链 + 语义图标；+菜单创建后进入重命名；恢复历史版本编辑器立即刷新（contentRevision key 重挂载）

## 待办（按优先级）

### 1. 阶段 2：画板文档（本期核心，方案见 plan 阶段 2）
- [x] 安装 excalidraw（`@excalidraw/excalidraw@0.18.1`；BoardCanvas 独立 chunk，BoardEditor 内 React.lazy 懒加载）
- [x] contentFormat 新增 `"board"`：SDK 类型 + 后端 knowledgeTreeCore/notes 路由 + openapi + 知识树图标/新建菜单（桌面 + 移动）
- [x] BoardEditor 编辑器（走 EditorPane 的 contentFormat 分支，未做 `/boards/:id` 独立路由；画板仍是知识库文档，和 sheets/mindmaps 的独立模块模型不同）
- [x] BlockEmbedExtension 加 `![[board:<id>]]` 解析 → BoardEmbedCard（只读态 `exportToSvg` 预览，点击"打开"进画板文档；Markdown 预览同管线）
- [x] 创建入口：富文本斜杠命令「嵌入画板」（知识树新建菜单已完成）；选择对话框由原 SheetEmbedInsertDialog 泛化为 KnowledgeDocEmbedDialog
- [x] 画板正文派生搜索文本：`noteBlocks.syncNoteBlocks` 必须对 board 提前返回，否则会被当成 Markdown 生成"整段 JSON"contentText（已修）

### 2. 匿名文档机制（插块即匿名、单独创建才有名，导图同步适用，方案 plan 阶段 2）
- [ ] notes 表加 `is_unlisted` 标记（新迁移，注意 DB 版本号递增；当前库版本见 backend/src/db/migrations.impl.ts 末尾）
- [ ] 知识树/列表/搜索查询过滤 unlisted=1
- [ ] 富文本插块（`![[board:]]` / `![[mindmap:]]` 新建）→ 自动创建匿名文档；块卡片提供"转为独立文档"
- [ ] 引用计数 GC：宿主笔记删除块/笔记后清理无引用匿名文档（对齐附件两阶段 GC 思路，见 backend 附件 GC 实现）
- [ ] **思维导图归一知识库文档**（用户 2026-10-23 新要求）：mindmap 从独立 mindmaps 表/独立模块迁为知识树文档类型（对齐画板方案：正文存导图 JSON 或迁表数据），树内直接创建/打开，去除独立化痕迹。迁移时保留现有 mindmaps 数据。注意：SidebarDesktop 的 openNode/fileIconFor 与 KnowledgeTreePanel.openDocument 都有导图深链分支，归一后同步调整。

### 3. 阶段 3：Word 导入即正文（方案 plan 阶段 3）
- [ ] 补 DocxIR→Tiptap JSON 适配器（反向已有：frontend/src/office/ 有 parseDocx 与 Tiptap→DocxIR）
- [ ] 导入 .docx 生成 tiptap-json 笔记 + 原件存附件；"导出为 .docx"复用现有序列化
- [ ] 复杂版式降级清单 + 导入报告
- [ ] 现有入口：知识树导入菜单"导入 Word 文档"（importWordIntoKnowledgeTree）

### 4. 阶段 4：PDF 保原件 + 批注层（方案 plan 阶段 4，用户已认可）
- [ ] contentFormat 新增 `"pdf"`，正文存 `{ attachmentId }` + 批注层数据
- [ ] 查看器复用 AttachmentPdfPreview（pdfjs-dist 已在用）+ 页码锚点笔记层（Tiptap 侧栏）

### 5. 小项（可选增强）
- [ ] `.txt` 导入对话框加"保持纯文本"开关（默认仍转 markdown）
- [ ] 命令面板目前没有"新建文档"命令（方案提过，暂缓）——补 plain/board 创建入口时一并考虑

## 已知坑（前人教训）
- EditorPane 各编辑器只在 mount 时读 note.content：任何"外部改正文"的场景（版本恢复、AI 写入等）都需要 contentRevision key 重挂载机制（见 EditorPane onRestore）
- SidebarDesktop 有自己独立的知识树实现（openNode/fileIconFor/handleCreate），与 KnowledgeTreePanel/MobileKnowledgeTreePanel 三处并存——改树行为要三处对齐
- plain/plainTextFromNoteContent、searchIndex.normalizeContentFormat 已放行 "plain"；新增格式值记得同步这两处 + SDK types + knowledgeTreeCore + notes.ts 创建路由 + capabilityCatalog（构建时生成）
- Excalidraw 的 onChange 也会随"空闲状态"等非场景 appState 变化触发；BoardEditor 已加"内容未变化不排队保存"的守卫，去掉会变成每秒一次无效 PUT + 版本膨胀
- 新增 contentFormat 后必须检查 `noteBlocks.syncNoteBlocks`（保存链路会在事务后再次覆盖 contentText）与 `searchIndex.normalizeContentFormat`，只改 `extractSearchableText` 不够
- wiki 嵌入（`![[mindmap:|board:]]`）只有正式预览/分屏走 MarkdownPreview 才渲染卡片；Markdown 的「实时预览」(cm inline) 仍显示原文，与 mindmap 行为一致
- 画板嵌入预览用 `exportToSvg(..., skipInliningFonts: true)`，字体依赖随 chunk 加载的 @font-face，不要在导出后删掉这份 CSS
