# 知识库块化核心增强方案（feat/kb-block-core）

状态：待评审
日期：2026-10-23
分支：feat/kb-block-core

## 一、目标回顾

以知识库为核心，支持：表格、markdown、富文本、思维导图、**画板**、**纯文本**、**pdf、word**；
以块为核心，导图/表格/画板等都能作为块插入；非核心功能（待办、小记等）插件化，可关闭。

本期（第一迭代）聚焦：**画板文档 + 纯文本文档**，其次 **word/pdf 导入方案**。插件化列为远期路线，不在本迭代动码。

## 二、现状盘点（调研结论）

| 能力 | 现状 | 关键位置 |
|------|------|----------|
| contentFormat | 仅 `markdown / tiptap-json / html` 三值（SDK 类型契约） | packages/nowen-sdk/src/types.ts:49-62 |
| 编辑器路由 | `resolveNoteEditorKind`：markdown→MD 编辑器，html→预览，其余→Tiptap | frontend/src/lib/noteEditorRouting.ts:2-12 |
| 块嵌入机制 | **已存在通用嵌入块**：`![[note:]]` `![[mindmap:]]` `![[sheet:]]`，BlockEmbedNodeView 懒加载 | frontend/src/components/BlockEmbedExtension.tsx:11-102 |
| 表格/导图 | 独立模块（sheets/:id、mindmaps/:id 深链）+ 嵌入卡片，块内可编辑 | SheetEmbedCard.tsx、MindMapEmbedCard.tsx |
| word | **自研 OOXML 管线已具备**：parseDocx→DocxIR→Tiptap 适配、IR→docx 导出 | frontend/src/office/（index.ts、docx-serializer.ts） |
| pdf | pdfjs-dist 已引入：附件预览（AttachmentPdfPreview）+ 导入时抽文本转 HTML | attachmentOpenStrategy.ts:43-65、importService.base.ts:536-578 |
| 纯文本 | `.txt` 可导入但被归入 Markdown 流，无独立 plain 格式 | importService.base.ts:536-604 |
| 画板 | **完全没有**（无 whiteboard/excalidraw/tldraw/konva/fabric） | — |

关键结论：**块嵌入底座、docx 解析/导出、pdfjs 三块底座都已存在**，本期主要是"补文档类型"而非"造底座"。

## 三、总体设计原则

1. **新文档类型 = 新 contentFormat 值 + 新编辑器路由 + 新嵌入卡片**，四件套齐才算完整模块（三分区纪律同理）。
2. 复用 BlockEmbedExtension 通用嵌入机制：新类型只加一种 `![[board:]]` 前缀解析，不另起炉灶。
3. contentFormat 是 TEXT 列，加新值**无需数据库迁移**；但 SDK 类型契约、校验白名单、版本历史快照要同步扩。
4. 编辑能力分层：画板/纯文本第一期"能建能编能嵌"，word/pdf 第一期"导入即正文 + 保原件"。

## 四、分期计划

### 阶段 1：纯文本文档（最小闭环，预计改动最小）

- **格式**：contentFormat 新增 `"plain"`（SDK 类型、前端路由、后端校验白名单同步）。
- **编辑器**：plain → 等宽字体 textarea 式编辑器（不复用 Tiptap，纯文本不做语法渲染）。
- **极简原则（已评审确认）**：纯文本就是纯文本——不要 blockId、不要块引用、不要任何增强，能建能编能存即可。
- **创建入口**：知识树新建菜单 + 命令面板加"纯文本文档"。
- **导入**：`.txt` 导入改为"可选保持 plain"（默认仍转 markdown，导入对话框加一个开关）。
- **验收**：新建/编辑/搜索正文/版本历史均正常。

### 阶段 2：画板文档（本期核心新增）

- **选型（已定）**：Excalidraw。理由：MIT 许可无水印（tldraw 为自有许可、生产要求水印/付费，排除）；canvas 渲染数百元素 60fps；场景为自描述 JSON（存正文 content，版本历史/Git 同步天然兼容）；元素级可编程、可接管应用主题；手绘风格与笔记气质匹配。
- **格式**：contentFormat 新增 `"board"`；正文 content 存 Excalidraw 场景 JSON。
- **编辑器**：全屏 BoardEditor（独立路由 /boards/:id 深链，对齐 sheets/mindmaps 模式）。
- **匿名文档机制（已评审确认，导图同步适用）**：
  - **在富文本里插入块**（`![[board:]]` / `![[mindmap:]]` 新建）→ 自动创建**匿名文档**：不在知识树/列表显示，仅以块形式存在于宿主笔记中；
  - **单独创建**画板/导图文档 → 正常有名文档，进知识树；
  - 实现：notes 表加 `is_unlisted` 标记（需迁移），知识树/列表/搜索查询过滤 unlisted；
  - GC：匿名文档被宿主唯一引用，宿主删除块或笔记后按引用计数清理（对齐附件两阶段 GC 思路）；
  - 匿名→有名升级：块卡片提供"转为独立文档"入口（命名 + 入树）。
  - 现有 mindmap 嵌入同步改造为新机制（`![[mindmap:new]]` 即插即建匿名导图）。
- **创建入口**：知识树新建菜单 + 命令面板 + 富文本块插入菜单加"画板文档"。
- **验收**：富文本插块即画（匿名）→ 保存刷新不丢 → 不出现在知识树；单独创建的有名画板入树；"转独立文档"升级可用；版本历史可回滚场景。

### 阶段 3：Word 导入增强（从"预览"升级为"导入即正文"）

- **现状**：office/ 已能 parseDocx→DocxIR，且已有 Tiptap JSON→DocxIR 适配（导出方向）。
- **方案**：补"DocxIR→Tiptap JSON"方向适配器，导入 .docx 时直接生成 `tiptap-json` 笔记（可编辑），同时原件存为附件（保留"下载原文件"）。
- **编辑后导出**：笔记可"导出为 .docx"（复用现有 IR→docx 序列化），形成双向闭环。
- **边界**：复杂版式（分栏、艺术字、文本框）不做无损还原，映射为最接近的 Tiptap 块并在导入报告中列出丢失项。
- **验收**：导入典型 docx（标题/列表/表格/图片）→ 编辑 → 导出 docx 再导入，内容不丢。

### 阶段 4：PDF 文档（保原件 + 批注层，不做"编辑 PDF 本体"）

- **方案**：contentFormat 新增 `"pdf"`，正文存 `{ attachmentId }` 引用 + 批注层数据；查看器复用 AttachmentPdfPreview（pdfjs），旁边挂"笔记层"（可编辑的 Tiptap 侧栏，支持页码锚点）。
- **不做**：PDF 内容本体编辑（业界无成熟轻量方案，投入产出比差）；已存在的"导入 PDF 抽文本转 HTML"路径保留，作为"想转正文"用户的选择。
- **验收**：新建/导入 PDF 文档→翻页预览→批注→重开不丢；原文件可随时下载。

### 远期路线（另立分支/迭代，本分支只留接口空间）

- 块注册表泛化：把 ![[前缀→卡片组件]] 的映射抽成注册表，插件可贡献块类型。
- 插件化：待办/小记等非核心功能迁为可停用插件（builtin registry 已支持启停）。
- 远程文档（WebDAV/SMB/百度网盘）已定为核心能力、不做插件化；可插件化的是 git 工单、广场论坛。

## 五、风险与依赖

| 风险 | 影响 | 对策 |
|------|------|------|
| Excalidraw 包体积（~1MB gzip） | 首屏 | 路由级 lazy + 嵌入卡片只渲染 SVG 预览 |
| Excalidraw 场景 JSON 与版本历史/全文搜索 | 搜索不命中图形文字 | 抽取场景内 text 元素进 contentText |
| DocxIR→Tiptap 适配的复杂表格/图片 | 还原度 | 首版明确降级清单，导入报告提示 |
| contentFormat 新值对旧客户端 | 旧端不识别 | 旧端 fallback 到 Tiptap/预览，需确认同步端兼容策略 |

## 六、评审状态

1. 画板选型：**已定 Excalidraw**（MIT、SVG 静态预览嵌入零开销、场景 JSON 可编程）。
2. 纯文本：**已定彻底极简**（无 blockId、无块引用）。
3. PDF："保原件+批注层"（不做本体编辑）：**已认可**。
4. 匿名文档机制（插入块=匿名、单独创建=有名、引用 GC、可升级）：**已认可，导图同步适用**。
5. 阶段顺序 1→2→3→4：**默认执行**，如有异议提出。
