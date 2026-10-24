// office/serializers/ir-to-tiptap.ts —— DocxIR → Tiptap JSON
//
// 阶段 3「Word 导入即正文」的转换核心：导入 .docx 时不再走
// mammoth HTML → generateJSON，而是自研 DocxIR → Tiptap JSON，
// 与预览管线（WordViewer）共用同一份解析结果，表格/编号/行内样式保真度更高。
//
// 覆盖范围（与 tiptap-to-ir 反向对齐）：
//   ✅ heading 1-6（styles.xml 反查后的 headingLevel）/ paragraph（textAlign）
//   ✅ text + marks: bold/italic/underline/strike + textStyle(color/fontSize/fontFamily)
//      + highlight(multicolor) + link（hyperlink）
//   ✅ 列表：相邻同 numId 段落按 ilvl 聚合成 bulletList/orderedList/listItem（支持嵌套）
//   ✅ table / tableRow / tableCell（gridSpan→colspan、rowSpan→rowspan）
//   ✅ image：blob/data URL → fetch bytes → uploadImage 回调 → 附件 URL（内联 await）
//
// 降级清单（不中断导入，记录到 downgrades 供导入报告展示）：
//   - 段落底纹 / 缩进 / 间距、单元格底纹 / 边框：编辑器无对应属性，丢弃
//   - 图片上传失败：降级为占位文本 [图片]
//
// 失败哲学与 tiptap-to-ir 一致：个别节点异常不炸整篇，能转多少转多少。

import type {
  DocxIR,
  ParagraphNode,
  RunNode,
  RunProps,
  InlineNode,
  BlockNode,
  TableNode,
  CellNode,
} from "../ir/document";

// ---------------------------------------------------------------------------
// Tiptap JSON 形态（结构化写入，字段与编辑器 schema 对齐）
// ---------------------------------------------------------------------------

export interface TipNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

// ---------------------------------------------------------------------------
// 入口与选项
// ---------------------------------------------------------------------------

export interface IrImageSource {
  bytes: Uint8Array;
  contentType: string;
}

export interface IrToTiptapOptions {
  /**
   * 上传一张图片并返回可访问 URL。导入链路把 bytes 存成附件，
   * 返回的附件 URL 写进正文。注意此时笔记必须已创建（附件挂在 noteId 下）。
   */
  uploadImage: (image: { bytes: Uint8Array; contentType: string; alt?: string }) => Promise<string>;
  /** IR 图片 src（blob/data URL）→ bytes。默认 fetch(blobUrl)，data URL 直接解码。 */
  fetchImageBytes?: (src: string) => Promise<IrImageSource>;
}

export interface IrToTiptapDowngrade {
  kind: string;
  detail: string;
  count: number;
}

export interface IrToTiptapResult {
  doc: TipNode;
  downgrades: IrToTiptapDowngrade[];
  imageCount: number;
  failedImageCount: number;
}

export async function irToTiptap(
  ir: DocxIR,
  opts: IrToTiptapOptions,
): Promise<IrToTiptapResult> {
  const ctx: BuildCtx = {
    opts,
    downgrades: new Map<string, IrToTiptapDowngrade>(),
    imageCount: 0,
    failedImageCount: 0,
  };

  const blocks: BlockNode[] = [];
  for (const section of ir.sections || []) {
    for (const block of section.body || []) blocks.push(block);
  }

  const content = await blocksToTip(blocks, ctx);

  return {
    doc: content.length > 0 ? { type: "doc", content } : { type: "doc", content: [{ type: "paragraph" }] },
    downgrades: Array.from(ctx.downgrades.values()),
    imageCount: ctx.imageCount,
    failedImageCount: ctx.failedImageCount,
  };
}

/** 从 IR 提取纯文本（contentText 用，与正文同源）。 */
export function irPlainText(ir: DocxIR): string {
  const parts: string[] = [];
  const collectInline = (inlines: InlineNode[]) => {
    for (const node of inlines) {
      if (node.type === "run") parts.push(node.text);
      else if (node.type === "hyperlink") collectInline(node.runs);
    }
  };
  const collectBlocks = (blocks: BlockNode[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph") collectInline(block.runs);
      else for (const row of block.rows) for (const cell of row.cells) collectBlocks(cell.body);
    }
  };
  for (const section of ir.sections || []) collectBlocks(section.body || []);
  return parts.join("").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 构建上下文
// ---------------------------------------------------------------------------

interface BuildCtx {
  opts: IrToTiptapOptions;
  downgrades: Map<string, IrToTiptapDowngrade>;
  imageCount: number;
  failedImageCount: number;
}

function recordDowngrade(ctx: BuildCtx, kind: string, detail: string): void {
  const existing = ctx.downgrades.get(kind);
  if (existing) existing.count += 1;
  else ctx.downgrades.set(kind, { kind, detail, count: 1 });
}

async function fetchImageBytes(src: string): Promise<IrImageSource> {
  if (src.startsWith("data:")) {
    const commaIndex = src.indexOf(",");
    const meta = src.slice(5, commaIndex);
    const binary = atob(src.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { bytes, contentType: meta.split(";")[0] || "image/png" };
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error(`fetch image failed: ${response.status}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "image/png",
  };
}

// ---------------------------------------------------------------------------
// 块级转换（含列表聚合）
// ---------------------------------------------------------------------------

interface ListFrame {
  numId: number;
  ilvl: number;
  listNode: TipNode;
  lastItem: TipNode | null;
}

async function blocksToTip(blocks: BlockNode[], ctx: BuildCtx): Promise<TipNode[]> {
  const out: TipNode[] = [];
  const listStack: ListFrame[] = [];

  const popListsTo = (depth: number) => {
    while (listStack.length > depth) {
      const frame = listStack.pop()!;
      const parent = listStack.length > 0 ? listStack[listStack.length - 1].lastItem : null;
      if (parent) parent.content = [...(parent.content || []), frame.listNode];
      else out.push(frame.listNode);
    }
  };

  for (const block of blocks) {
    if (block.type === "table") {
      popListsTo(0);
      const table = await tableToTip(block, ctx);
      if (table) out.push(table);
      continue;
    }
    if (block.list) {
      const { numId, ilvl, numFmt } = block.list;
      const ordered = numFmt !== "bullet";
      // 弹出比当前层级更深、或已切换编号的列表帧
      while (
        listStack.length > 0
        && (listStack[listStack.length - 1].numId !== numId || listStack[listStack.length - 1].ilvl > ilvl)
      ) {
        popListsTo(listStack.length - 1);
      }
      const top = listStack[listStack.length - 1];
      let frame: ListFrame;
      if (top && top.numId === numId && top.ilvl === ilvl) {
        frame = top;
      } else {
        const listNode: TipNode = {
          type: ordered ? "orderedList" : "bulletList",
          ...(ordered ? { attrs: { start: 1 } } : {}),
          content: [],
        };
        // 挂载延迟到弹出时（popListsTo）：避免创建时挂一次、弹出再挂一次的重复
        frame = { numId, ilvl, listNode, lastItem: null };
        listStack.push(frame);
      }
      const item: TipNode = {
        type: "listItem",
        content: [await paragraphToTip(block, ctx)],
      };
      frame.listNode.content = [...(frame.listNode.content || []), item];
      frame.lastItem = item;
      continue;
    }
    popListsTo(0);
    if (block.headingLevel) {
      const heading = await headingToTip(block, ctx);
      if (heading) out.push(heading);
      continue;
    }
    if (block.runs.length === 0) continue; // Word 空段落多为排版噪音，丢弃
    out.push(await paragraphToTip(block, ctx));
  }
  popListsTo(0);
  return out;
}

async function headingToTip(block: ParagraphNode, ctx: BuildCtx): Promise<TipNode | null> {
  const level = Math.min(6, Math.max(1, Math.round(block.headingLevel || 1)));
  const inlines = await inlinesToTip(block.runs, block.defaultRun, ctx);
  if (inlines.length === 0) return null; // 空标题丢弃
  const attrs: Record<string, unknown> = { level };
  if (block.alignment && block.alignment !== "left") attrs.textAlign = block.alignment;
  return { type: "heading", attrs, content: inlines };
}

async function paragraphToTip(block: ParagraphNode, ctx: BuildCtx): Promise<TipNode> {
  if (block.shading) recordDowngrade(ctx, "paragraph-shading", "段落底纹");
  if (block.indent) recordDowngrade(ctx, "paragraph-indent", "段落缩进");
  if (block.spacing && (block.spacing.before || block.spacing.after || block.spacing.line)) {
    recordDowngrade(ctx, "paragraph-spacing", "段落间距");
  }
  const inlines = await inlinesToTip(block.runs, block.defaultRun, ctx);
  if (inlines.length === 0) return { type: "paragraph" };
  const attrs: Record<string, unknown> = {};
  if (block.alignment && block.alignment !== "left") attrs.textAlign = block.alignment;
  return { type: "paragraph", attrs, content: inlines };
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

async function tableToTip(table: TableNode, ctx: BuildCtx): Promise<TipNode | null> {
  if (table.alignment && table.alignment !== "left") {
    recordDowngrade(ctx, "table-alignment", "表格整体对齐");
  }
  const rows: TipNode[] = [];
  for (const row of table.rows) {
    const cells: TipNode[] = [];
    for (const cell of row.cells) cells.push(await cellToTip(cell, ctx));
    if (cells.length > 0) rows.push({ type: "tableRow", content: cells });
  }
  if (rows.length === 0) return null;
  return { type: "table", content: rows };
}

async function cellToTip(cell: CellNode, ctx: BuildCtx): Promise<TipNode> {
  if (cell.shading) recordDowngrade(ctx, "cell-shading", "单元格底纹");
  if (cell.borders) recordDowngrade(ctx, "cell-borders", "单元格边框样式");
  const content: TipNode[] = [];
  for (const paragraph of cell.body) {
    const node = await paragraphToTip(paragraph, ctx);
    if ((node.content?.length || 0) > 0) content.push(node);
  }
  const attrs: Record<string, unknown> = {};
  if (cell.gridSpan > 1) attrs.colspan = cell.gridSpan;
  if (cell.rowSpan > 1) attrs.rowspan = cell.rowSpan;
  return { type: "tableCell", attrs, content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

// ---------------------------------------------------------------------------
// 行内转换
// ---------------------------------------------------------------------------

async function inlinesToTip(runs: InlineNode[], defaultRun: RunProps | undefined, ctx: BuildCtx): Promise<TipNode[]> {
  const out: TipNode[] = [];
  for (const inline of runs) {
    if (inline.type === "run") {
      const text = runToTip(inline, defaultRun);
      if (text) out.push(text);
    } else if (inline.type === "hyperlink") {
      for (const run of inline.runs) {
        const text = runToTip(run, defaultRun);
        if (!text) continue;
        text.marks = [...(text.marks || []), { type: "link", attrs: { href: inline.href } }];
        out.push(text);
      }
    } else if (inline.type === "image") {
      out.push(await imageToTip(inline, ctx));
    }
  }
  return out;
}

function runToTip(run: RunNode, defaultRun: RunProps | undefined): TipNode | null {
  const text = run.text || "";
  if (!text) return null;
  const props: RunProps = { ...defaultRun, ...run.props };
  const marks: NonNullable<TipNode["marks"]> = [];
  if (props.bold) marks.push({ type: "bold", attrs: {} });
  if (props.italic) marks.push({ type: "italic", attrs: {} });
  if (props.underline) marks.push({ type: "underline", attrs: {} });
  if (props.strike) marks.push({ type: "strike", attrs: {} });
  const textStyle: Record<string, unknown> = {};
  if (props.color) textStyle.color = `#${props.color}`;
  if (props.fontSize) textStyle.fontSize = `${props.fontSize}pt`;
  if (props.fontFamily) textStyle.fontFamily = props.fontFamily;
  if (Object.keys(textStyle).length > 0) marks.push({ type: "textStyle", attrs: textStyle });
  if (props.highlight) marks.push({ type: "highlight", attrs: { color: props.highlight } });
  return { type: "text", text, ...(marks.length > 0 ? { marks } : {}) };
}

async function imageToTip(
  image: Extract<InlineNode, { type: "image" }>,
  ctx: BuildCtx,
): Promise<TipNode> {
  ctx.imageCount += 1;
  try {
    const source = ctx.opts.fetchImageBytes
      ? await ctx.opts.fetchImageBytes(image.src)
      : await fetchImageBytes(image.src);
    const url = await ctx.opts.uploadImage({
      bytes: source.bytes,
      contentType: source.contentType,
      alt: image.alt,
    });
    const attrs: Record<string, unknown> = { src: url, alt: image.alt || null };
    // Tiptap image 以 px 展示；IR 是 pt（1pt ≈ 1.333px），直接取整交给编辑器缩放
    if (image.widthPt) attrs.width = Math.round(image.widthPt * (4 / 3));
    return { type: "image", attrs };
  } catch {
    ctx.failedImageCount += 1;
    recordDowngrade(ctx, "image-failed", "图片上传失败，已降级为占位文本");
    return { type: "text", text: "[图片]" };
  }
}
