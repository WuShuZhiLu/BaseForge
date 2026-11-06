#!/usr/bin/env node
/**
 * BaseForge MCP Server
 *
 * 让 Codex CLI / Claude Desktop / Cursor 等 AI 工具直接操作 BaseForge 笔记系统。
 *
 * 环境变量：
 *   BASEFORGE_URL       — BaseForge 后端地址（默认 http://localhost:3001）
 *   BASEFORGE_API_TOKEN — Personal API Token（设置 → 个人访问令牌 创建）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BaseForgeApiClient } from "./api-client.js";
import {
  CONTENT_FORMAT_VALUES,
  buildCreateNotePayload,
  buildReadNoteResult,
  buildUpdateNotePayloadWithCurrentVersion,
} from "./note-format.js";

// ===== 从环境变量读取配置 =====
const config = {
  baseUrl: process.env.BASEFORGE_URL || "http://localhost:3001",
  apiToken: process.env.BASEFORGE_API_TOKEN || "",
};

if (!config.apiToken) {
  console.error("缺少 BASEFORGE_API_TOKEN。请在 BaseForge 设置 → 个人访问令牌 创建一个 Token，并写入客户端 MCP 配置的 env。");
  process.exit(1);
}

const api = new BaseForgeApiClient(config);

/** 统一的工具返回包装：字符串原样输出，其余序列化为 JSON。 */
function textResult(data: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `错误: ${message}` }],
    isError: true as const,
  };
}

// ===== 创建 MCP Server =====
const server = new McpServer({
  name: "baseforge",
  version: "1.0.0",
});

// ==================== 笔记本工具 ====================

server.tool(
  "baseforge_list_notebooks",
  "获取 BaseForge 中的所有笔记本列表（支持树形结构），返回每个笔记本的 id、名称、图标、颜色和笔记数量",
  {},
  async () => {
    try {
      const notebooks = await api.listNotebooks();
      const summary = notebooks.map((nb: any) => ({
        id: nb.id,
        name: nb.name,
        icon: nb.icon,
        color: nb.color,
        parentId: nb.parentId,
        noteCount: nb.noteCount,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_create_notebook",
  "在 BaseForge 中创建一个新笔记本",
  {
    name: z.string().describe("笔记本名称"),
    parentId: z.string().optional().describe("父笔记本 ID（可选，创建子笔记本时使用）"),
    icon: z.string().optional().describe("笔记本图标 emoji（默认 📒）"),
  },
  async ({ name, parentId, icon }) => {
    try {
      const notebook = await api.createNotebook({ name, parentId, icon });
      return {
        content: [{ type: "text" as const, text: `笔记本创建成功:\n${JSON.stringify(notebook, null, 2)}` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 笔记工具 ====================

server.tool(
  "baseforge_list_notes",
  "获取 BaseForge 中的笔记列表。可按笔记本、标签、收藏状态、日期范围等筛选。返回笔记概要（不含完整内容）",
  {
    notebookId: z.string().optional().describe("按笔记本 ID 筛选"),
    tagId: z.string().optional().describe("按标签 ID 筛选"),
    isFavorite: z.boolean().optional().describe("是否只返回收藏笔记"),
    isTrashed: z.boolean().optional().describe("是否只返回回收站笔记"),
    search: z.string().optional().describe("全文搜索关键词"),
    dateFrom: z.string().optional().describe("开始日期 YYYY-MM-DD"),
    dateTo: z.string().optional().describe("结束日期 YYYY-MM-DD"),
  },
  async ({ notebookId, tagId, isFavorite, isTrashed, search, dateFrom, dateTo }) => {
    try {
      const query: Record<string, string> = {};
      if (notebookId) query.notebookId = notebookId;
      if (tagId) query.tagId = tagId;
      if (isFavorite) query.isFavorite = "1";
      if (isTrashed) query.isTrashed = "1";
      if (search) query.search = search;
      if (dateFrom) query.dateFrom = dateFrom;
      if (dateTo) query.dateTo = dateTo;

      const notes = await api.listNotes(query);
      const summary = notes.map((n: any) => ({
        id: n.id,
        title: n.title,
        notebookId: n.notebookId,
        isPinned: n.isPinned,
        isFavorite: n.isFavorite,
        isLocked: n.isLocked,
        updatedAt: n.updatedAt,
        contentPreview: n.contentText?.slice(0, 100),
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_read_note",
  "读取指定笔记，可返回纯文本、Markdown/原始正文或结构化块树",
  {
    noteId: z.string().describe("笔记 ID"),
    mode: z.enum(["text", "markdown", "blocks"]).optional().describe("返回模式，默认 text"),
    includeBlockIds: z.boolean().optional().describe("text/markdown 模式是否同时附带块 ID 列表"),
    maxBlocks: z.number().int().positive().max(2000).optional().describe("blocks 模式最大块数量，默认 500"),
  },
  async ({ noteId, mode, includeBlockIds, maxBlocks }) => {
    try {
      const note = await api.getNote(noteId);
      const selectedMode = mode || "text";
      if (selectedMode === "blocks") {
        const blocks = await api.listNoteBlocks(noteId, maxBlocks || 500);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            id: note.id,
            title: note.title,
            notebookId: note.notebookId,
            version: note.version,
            contentFormat: note.contentFormat,
            blocks,
          }, null, 2) }],
        };
      }
      const result: any = selectedMode === "markdown"
        ? {
            id: note.id,
            title: note.title,
            notebookId: note.notebookId,
            version: note.version,
            contentFormat: note.contentFormat,
            content: note.content,
          }
        : buildReadNoteResult(note);
      if (includeBlockIds) result.blocks = await api.listNoteBlocks(noteId, maxBlocks || 500);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_create_note",
  "在 BaseForge 中创建一篇新笔记。需要指定目标笔记本 ID",
  {
    notebookId: z.string().describe("目标笔记本 ID"),
    title: z.string().optional().describe("笔记标题(默认为'无标题笔记')"),
    content: z.string().optional().describe("笔记内容（Markdown 纯文本）"),
    contentFormat: z.enum(CONTENT_FORMAT_VALUES).optional().describe("内容格式，默认 markdown"),
  },
  async ({ notebookId, title, content, contentFormat }) => {
    try {
      const body = buildCreateNotePayload({ notebookId, title, content, contentFormat });
      const note = await api.createNote(body);
      return {
        content: [{ type: "text" as const, text: `笔记创建成功:\n${JSON.stringify({ id: note.id, title: note.title }, null, 2)}` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_update_note",
  "更新 BaseForge 中已有笔记的标题或内容",
  {
    noteId: z.string().describe("笔记 ID"),
    title: z.string().optional().describe("新标题"),
    content: z.string().optional().describe("新内容（Markdown 纯文本）"),
    contentFormat: z.enum(CONTENT_FORMAT_VALUES).optional().describe("内容格式，默认 markdown"),
  },
  async ({ noteId, title, content, contentFormat }) => {
    try {
      const body = await buildUpdateNotePayloadWithCurrentVersion(api, { noteId, title, content, contentFormat });
      const note = await api.updateNote(noteId, body);
      return {
        content: [{ type: "text" as const, text: `笔记更新成功:\n${JSON.stringify({ id: note.id, title: note.title, version: note.version }, null, 2)}` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_delete_note",
  "将 BaseForge 中指定笔记移入回收站（软删除），或从回收站永久删除",
  {
    noteId: z.string().describe("笔记 ID"),
    permanent: z.boolean().optional().describe("是否永久删除（默认 false，仅移入回收站）"),
  },
  async ({ noteId, permanent }) => {
    try {
      if (permanent) {
        await api.deleteNote(noteId);
        return { content: [{ type: "text" as const, text: `笔记已永久删除: ${noteId}` }] };
      } else {
        await api.updateNote(noteId, { isTrashed: 1 });
        return { content: [{ type: "text" as const, text: `笔记已移入回收站: ${noteId}` }] };
      }
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);


// ==================== 双链与块工具 ====================

const noteBlockTypeSchema = z.enum(["heading", "paragraph", "listItem", "taskItem", "blockquote", "codeBlock"]);

server.tool(
  "baseforge_resolve_link",
  "解析 note: 内部链接，返回目标笔记和可选目标块",
  { link: z.string().describe("note:<noteId> 或 note:<noteId>#blk:<blockId>") },
  async ({ link }) => {
    try {
      const result = await api.resolveInternalLink(link);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "baseforge_get_backlinks",
  "获取引用指定笔记的来源笔记和来源块",
  {
    noteId: z.string().describe("目标笔记 ID"),
    limit: z.number().int().positive().max(200).optional().describe("最大结果数，默认 100"),
  },
  async ({ noteId, limit }) => {
    try {
      const backlinks = await api.getBacklinks(noteId, limit || 100);
      return { content: [{ type: "text" as const, text: JSON.stringify(backlinks, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "baseforge_get_block",
  "按 noteId + blockId 读取单个结构化块",
  {
    noteId: z.string().describe("笔记 ID"),
    blockId: z.string().describe("块 ID"),
  },
  async ({ noteId, blockId }) => {
    try {
      const block = await api.getBlock(noteId, blockId);
      return { content: [{ type: "text" as const, text: JSON.stringify(block, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "baseforge_search_blocks",
  "全文搜索块，返回 noteId、blockId、块类型、文本和路径",
  {
    query: z.string().describe("搜索关键词"),
    notebookId: z.string().optional().describe("限定笔记本 ID"),
    limit: z.number().int().positive().max(200).optional().describe("最大结果数，默认 50"),
  },
  async ({ query, notebookId, limit }) => {
    try {
      const blocks = await api.searchBlocks(query, { notebookId, limit: limit || 50 });
      return { content: [{ type: "text" as const, text: JSON.stringify(blocks, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "baseforge_get_block_backlinks",
  "获取指向指定块的来源笔记和来源块",
  {
    noteId: z.string().describe("目标笔记 ID"),
    blockId: z.string().describe("目标块 ID"),
  },
  async ({ noteId, blockId }) => {
    try {
      const backlinks = await api.getBlockBacklinks(noteId, blockId);
      return { content: [{ type: "text" as const, text: JSON.stringify(backlinks, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "baseforge_create_block",
  "在笔记中创建块；通过 expectedNoteVersion 防并发覆盖，operationId 保证重试幂等",
  {
    noteId: z.string().describe("笔记 ID"),
    blockType: noteBlockTypeSchema.optional().describe("块类型，默认 paragraph"),
    text: z.string().optional().describe("块文本"),
    afterBlockId: z.string().optional().describe("插入到该块之后；不传则追加"),
    expectedNoteVersion: z.number().int().positive().describe("当前笔记版本"),
    operationId: z.string().min(8).max(128).describe("调用方生成的幂等操作 ID"),
  },
  async ({ noteId, blockType, text, afterBlockId, expectedNoteVersion, operationId }) => {
    try {
      const result = await api.createBlock(noteId, { blockType, text, afterBlockId, expectedNoteVersion, operationId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "baseforge_update_block",
  "更新块文本，要求笔记版本和幂等操作 ID",
  {
    noteId: z.string().describe("笔记 ID"),
    blockId: z.string().describe("块 ID"),
    text: z.string().describe("新文本"),
    expectedNoteVersion: z.number().int().positive().describe("当前笔记版本"),
    operationId: z.string().min(8).max(128).describe("幂等操作 ID"),
  },
  async ({ noteId, blockId, text, expectedNoteVersion, operationId }) => {
    try {
      const result = await api.updateBlock(noteId, blockId, { text, expectedNoteVersion, operationId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "baseforge_delete_block",
  "删除块，要求笔记版本和幂等操作 ID",
  {
    noteId: z.string().describe("笔记 ID"),
    blockId: z.string().describe("块 ID"),
    expectedNoteVersion: z.number().int().positive().describe("当前笔记版本"),
    operationId: z.string().min(8).max(128).describe("幂等操作 ID"),
  },
  async ({ noteId, blockId, expectedNoteVersion, operationId }) => {
    try {
      const result = await api.deleteBlock(noteId, blockId, { expectedNoteVersion, operationId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "baseforge_move_block",
  "在同一父块内移动块，要求笔记版本和幂等操作 ID",
  {
    noteId: z.string().describe("笔记 ID"),
    blockId: z.string().describe("要移动的块 ID"),
    targetBlockId: z.string().describe("目标块 ID"),
    position: z.enum(["before", "after"]).optional().describe("放在目标之前或之后，默认 after"),
    expectedNoteVersion: z.number().int().positive().describe("当前笔记版本"),
    operationId: z.string().min(8).max(128).describe("幂等操作 ID"),
  },
  async ({ noteId, blockId, targetBlockId, position, expectedNoteVersion, operationId }) => {
    try {
      const result = await api.moveBlock(noteId, blockId, { targetBlockId, position, expectedNoteVersion, operationId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

// ==================== 附件工具 ====================

server.tool(
  "baseforge_upload_attachment",
  "上传本地文件到 BaseForge。传 noteId 时绑定指定笔记；不传 noteId 时上传到文件管理。返回的 url 可直接写入 Markdown 图片或链接",
  {
    filePath: z.string().describe("本地文件路径"),
    noteId: z.string().optional().describe("目标笔记 ID（可选；传入后走 /api/attachments）"),
    filename: z.string().optional().describe("上传时使用的文件名（可选）"),
    mimeType: z.string().optional().describe("MIME 类型（可选；未传会按扩展名做基础推断）"),
    workspaceId: z.string().optional().describe("工作区 ID（可选；仅未绑定上传时使用）"),
    folderId: z.string().optional().describe("附件文件夹 ID（可选；仅未绑定上传时使用）"),
  },
  async ({ filePath, noteId, filename, mimeType, workspaceId, folderId }) => {
    try {
      const result = await api.uploadAttachment({ filePath, noteId, filename, mimeType, workspaceId, folderId });
      return {
        content: [{
          type: "text" as const,
          text: `附件上传成功:\n${JSON.stringify({
            id: result.id,
            url: result.url,
            mimeType: result.mimeType,
            size: result.size,
            filename: result.filename,
            category: result.category,
            markdown: result.category === "image"
              ? `![${result.filename}](${result.url})`
              : `[${result.filename}](${result.url}?download=1)`,
          }, null, 2)}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_list_attachments",
  "列出 BaseForge 文件管理中的附件，可按类型、笔记、笔记本、文件夹、关键词和引用状态筛选",
  {
    category: z.enum(["all", "image", "file"]).optional().describe("附件类型，默认 all"),
    filter: z.enum(["unreferenced", "myUploads"]).optional().describe("筛选视图：无引用或我的上传"),
    myUploadsRef: z.enum(["referenced", "unreferenced"]).optional().describe("我的上传子筛选"),
    noteId: z.string().optional().describe("只列出被该笔记引用过的附件"),
    notebookId: z.string().optional().describe("按笔记本筛选"),
    folderId: z.string().optional().describe("按附件文件夹筛选；__unarchived 表示未归档"),
    q: z.string().optional().describe("文件名关键词"),
    page: z.number().int().positive().optional().describe("页码，默认 1"),
    pageSize: z.number().int().positive().max(200).optional().describe("每页数量，默认 50，最大 200"),
    workspaceId: z.string().optional().describe("工作区 ID（可选）"),
  },
  async (params) => {
    try {
      const result = await api.listAttachments(params);
      const summary = (result.items || []).map((file: any) => ({
        id: file.id,
        filename: file.filename,
        url: file.url,
        mimeType: file.mimeType,
        size: file.size,
        category: file.category,
        primaryNote: file.primaryNote,
      }));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ items: summary, total: result.total, page: result.page, pageSize: result.pageSize }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_attach_to_note",
  "把已上传附件插入指定 Markdown 笔记正文。图片生成 ![alt](url)，其它文件生成下载链接，并携带当前 version 更新笔记",
  {
    noteId: z.string().describe("目标笔记 ID"),
    attachmentId: z.string().describe("附件 ID"),
    alt: z.string().optional().describe("图片 alt 文本或文件链接标题"),
    mode: z.enum(["append", "prepend", "replace_marker"]).optional().describe("插入模式，默认 append"),
    marker: z.string().optional().describe("replace_marker 模式要替换的占位文本"),
  },
  async ({ noteId, attachmentId, alt, mode, marker }) => {
    try {
      const note = await api.attachToNote({ noteId, attachmentId, alt, mode, marker });
      return {
        content: [{
          type: "text" as const,
          text: `附件已插入笔记:\n${JSON.stringify({ id: note.id, title: note.title, version: note.version }, null, 2)}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 搜索工具 ====================

server.tool(
  "baseforge_search",
  "搜索笔记或块；块级搜索会返回稳定 blockId",
  {
    query: z.string().describe("搜索关键词"),
    level: z.enum(["note", "block"]).optional().describe("搜索层级，默认 note"),
    notebookId: z.string().optional().describe("块级搜索时限定笔记本"),
    limit: z.number().int().positive().max(200).optional().describe("块级结果上限"),
  },
  async ({ query, level, notebookId, limit }) => {
    try {
      if (level === "block") {
        const blocks = await api.searchBlocks(query, { notebookId, limit: limit || 50 });
        return { content: [{ type: "text" as const, text: `找到 ${blocks.length} 个块:\n${JSON.stringify(blocks, null, 2)}` }] };
      }
      const results = await api.search(query);
      const summary = results.map((r: any) => ({
        id: r.id,
        title: r.title,
        snippet: r.snippet,
        notebookId: r.notebookId,
        updatedAt: r.updatedAt,
      }));
      return {
        content: [{ type: "text" as const, text: `找到 ${results.length} 条结果:\n${JSON.stringify(summary, null, 2)}` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 标签工具 ====================

server.tool(
  "baseforge_list_tags",
  "获取 BaseForge 中的所有标签列表，包含每个标签的颜色和关联笔记数",
  {},
  async () => {
    try {
      const tags = await api.listTags();
      const summary = tags.map((t: any) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        noteCount: t.noteCount,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_manage_tags",
  "管理 BaseForge 中笔记的标签：创建标签、给笔记添加标签、或移除笔记标签",
  {
    action: z.enum(["create", "add_to_note", "remove_from_note"]).describe("操作类型: create=创建标签, add_to_note=给笔记添加标签, remove_from_note=移除笔记标签"),
    tagName: z.string().optional().describe("标签名称（创建时必填）"),
    tagColor: z.string().optional().describe("标签颜色（创建时可选，默认蓝色）"),
    tagId: z.string().optional().describe("标签 ID（添加/移除时必填）"),
    noteId: z.string().optional().describe("笔记 ID（添加/移除时必填）"),
  },
  async ({ action, tagName, tagColor, tagId, noteId }) => {
    try {
      switch (action) {
        case "create": {
          if (!tagName) throw new Error("创建标签时 tagName 必填");
          const tag = await api.createTag({ name: tagName, color: tagColor });
          return { content: [{ type: "text" as const, text: `标签创建成功:\n${JSON.stringify(tag, null, 2)}` }] };
        }
        case "add_to_note": {
          if (!noteId || !tagId) throw new Error("添加标签时 noteId 和 tagId 必填");
          await api.addTagToNote(noteId, tagId);
          return { content: [{ type: "text" as const, text: `已为笔记 ${noteId} 添加标签 ${tagId}` }] };
        }
        case "remove_from_note": {
          if (!noteId || !tagId) throw new Error("移除标签时 noteId 和 tagId 必填");
          await api.removeTagFromNote(noteId, tagId);
          return { content: [{ type: "text" as const, text: `已移除笔记 ${noteId} 的标签 ${tagId}` }] };
        }
      }
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 远程文件（内核能力） ====================
// 需要在 Token 上授予 remote_files:read / remote_files:write。

server.tool(
  "baseforge_list_remote_sources",
  "列出已配置的远程文件源（WebDAV / 百度网盘 / SMB）。凭据由服务端掩码，只返回名称、类型与地址",
  {},
  async () => {
    try {
      return textResult(await api.listRemoteSources());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_manage_remote_source",
  "新建、更新、删除或测试远程文件源。create/update 需提供 type 与 name；WebDAV/SMB 需 baseUrl，百度网盘需 accessToken。仅更新时传 sourceId 作为 id",
  {
    action: z.enum(["create", "update", "delete", "test"]).describe("操作类型"),
    sourceId: z.string().optional().describe("源 ID；update/delete/test 必填"),
    type: z.enum(["webdav", "baidu", "smb"]).optional().describe("存储类型；create 必填"),
    name: z.string().optional().describe("源名称；create 必填"),
    baseUrl: z.string().optional().describe("WebDAV/SMB 地址"),
    username: z.string().optional().describe("用户名"),
    password: z.string().optional().describe("密码（仅在创建/更新时提交，接口不会回传）"),
    rootPath: z.string().optional().describe("根路径"),
    accessToken: z.string().optional().describe("百度网盘 access_token"),
    domain: z.string().optional().describe("SMB 域"),
    clientId: z.string().optional().describe("OAuth clientId"),
    clientSecret: z.string().optional().describe("OAuth clientSecret"),
    refreshToken: z.string().optional().describe("OAuth refreshToken"),
  },
  async ({ action, sourceId, ...fields }) => {
    try {
      if (action === "delete" || action === "test") {
        if (!sourceId) throw new Error(`${action} 需要提供 sourceId`);
        return textResult(action === "delete"
          ? await api.deleteRemoteSource(sourceId)
          : await api.testRemoteSource(sourceId));
      }
      const body: Record<string, unknown> = { ...fields };
      if (action === "update") {
        if (!sourceId) throw new Error("update 需要提供 sourceId");
        body.id = sourceId;
      }
      return textResult(await api.saveRemoteSource(body));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_list_remote_files",
  "列出远程源某个目录下的文件与子目录",
  {
    sourceId: z.string().describe("远程源 ID"),
    path: z.string().optional().describe("远程目录路径，默认根目录"),
  },
  async ({ sourceId, path }) => {
    try {
      return textResult(await api.remoteFileOp(sourceId, "list", { path: path || "" }));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_read_remote_file",
  "读取远程源上的文本类文件（md/txt/json 等），返回内容与元信息",
  {
    sourceId: z.string().describe("远程源 ID"),
    path: z.string().describe("远程文件路径"),
  },
  async ({ sourceId, path }) => {
    try {
      return textResult(await api.remoteFileOp(sourceId, "read", { path }));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_write_remote_file",
  "把文本内容写回远程源上的文本类文件。会覆盖远端文件，请先用 read 确认内容",
  {
    sourceId: z.string().describe("远程源 ID"),
    path: z.string().describe("远程文件路径"),
    content: z.string().describe("要写入的完整文本内容"),
  },
  async ({ sourceId, path, content }) => {
    try {
      return textResult(await api.remoteFileOp(sourceId, "write", { path, content }));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_manage_remote_file",
  "远程文件管理：创建目录、删除文件或目录、重命名。删除不可恢复，请谨慎调用",
  {
    sourceId: z.string().describe("远程源 ID"),
    action: z.enum(["mkdir", "delete", "rename"]).describe("操作类型"),
    path: z.string().describe("目标路径"),
    newName: z.string().optional().describe("rename 时的新名称（不含路径分隔符）"),
  },
  async ({ sourceId, action, path, newName }) => {
    try {
      if (action === "rename" && !newName) throw new Error("rename 需要提供 newName");
      return textResult(await api.remoteFileOp(sourceId, action, { path, newName }));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_list_remote_links",
  "列出远程文件与本地笔记的链接映射（用于远程文档与笔记同步）",
  {},
  async () => {
    try {
      return textResult(await api.listRemoteLinks());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_manage_remote_link",
  "新建、更新或删除远程文件与本地笔记的链接映射。create 需 noteId，delete 需 sourceId + remotePath",
  {
    action: z.enum(["create", "update", "delete"]).describe("操作类型"),
    sourceId: z.string().describe("远程源 ID"),
    remotePath: z.string().describe("远程文件路径"),
    noteId: z.string().optional().describe("本地笔记 ID；create 必填"),
    title: z.string().optional().describe("链接标题"),
    baseRemoteHash: z.string().optional().describe("远端内容基线哈希"),
    baseNoteHash: z.string().optional().describe("笔记内容基线哈希"),
  },
  async ({ action, ...fields }) => {
    try {
      if (action === "create" && !fields.noteId) throw new Error("create 需要提供 noteId");
      return textResult(await api.manageRemoteLink(action, fields));
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ==================== 导出与分享（知识库为单位） ====================
// 导出需要 export:import；分享需要 shares:read / shares:write 且仅 unrestricted Token 可用。

server.tool(
  "baseforge_export_notes",
  "按知识库导出笔记。返回该笔记本下所有笔记的标题、正文、所属笔记本与更新时间（服务端按用户隔离，工具侧只返回指定笔记本）",
  {
    notebookId: z.string().describe("要导出的笔记本 ID"),
    workspaceId: z.string().optional().describe("工作区 ID；个人空间留空"),
  },
  async ({ notebookId, workspaceId }) => {
    try {
      const notes = await api.exportNotes(workspaceId);
      const filtered = (Array.isArray(notes) ? notes : []).filter((n: any) => n.notebookId === notebookId);
      return textResult({ notebookId, count: filtered.length, notes: filtered });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_list_shares",
  "列出当前用户创建的分享链接（仅 unrestricted Token 可用）",
  {},
  async () => {
    try {
      return textResult(await api.listShares());
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_create_share",
  "为一篇笔记创建分享链接（仅 unrestricted Token 可用）。默认 7 天后过期，expiresAt 传 null 表示永久",
  {
    noteId: z.string().describe("要分享的笔记 ID"),
    permission: z.enum(["view", "comment", "edit", "edit_auth"]).optional().describe("分享权限，默认 view"),
    password: z.string().optional().describe("访问密码"),
    expiresAt: z.string().nullable().optional().describe("过期时间 ISO 字符串；null 表示永久"),
    maxViews: z.number().int().positive().optional().describe("最大访问会话数"),
  },
  async (params) => {
    try {
      return textResult(await api.createShare(params));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_update_share",
  "修改分享链接的权限、过期时间、访问上限或启用状态（仅 unrestricted Token 可用）",
  {
    id: z.string().describe("分享 ID"),
    permission: z.enum(["view", "comment", "edit", "edit_auth"]).optional(),
    expiresAt: z.string().nullable().optional(),
    maxViews: z.number().int().positive().nullable().optional(),
    isActive: z.boolean().optional(),
  },
  async ({ id, ...fields }) => {
    try {
      return textResult(await api.updateShare(id, fields));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "baseforge_delete_share",
  "吊销分享链接（仅 unrestricted Token 可用）",
  {
    id: z.string().describe("分享 ID"),
  },
  async ({ id }) => {
    try {
      return textResult(await api.deleteShare(id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ==================== 插件工具 ====================

server.tool(
  "baseforge_list_plugins",
  "获取 BaseForge 中已加载的插件列表，每个插件声明了它支持的能力（action）（仅 unrestricted Token 可用）",
  {},
  async () => {
    try {
      const plugins = await api.listPlugins();
      return { content: [{ type: "text" as const, text: JSON.stringify(plugins, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_execute_plugin",
  "执行 BaseForge 中指定名称的插件，传入参数并获取处理结果（仅 unrestricted Token 可用）",
  {
    pluginName: z.string().describe("插件名称"),
    params: z.record(z.any()).describe("传给插件的参数对象"),
  },
  async ({ pluginName, params }) => {
    try {
      const result = await api.executePlugin(pluginName, params);
      if (result.text) {
        return { content: [{ type: "text" as const, text: result.text }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== Webhook 工具 ====================

server.tool(
  "baseforge_list_webhooks",
  "获取 BaseForge 中已配置的 Webhook 列表（仅 unrestricted Token 可用）",
  {},
  async () => {
    try {
      const webhooks = await api.listWebhooks();
      return { content: [{ type: "text" as const, text: JSON.stringify(webhooks, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_create_webhook",
  "在 BaseForge 中创建新的 Webhook，当指定事件发生时自动推送 HTTP 通知（仅 unrestricted Token 可用）",
  {
    url: z.string().describe("Webhook 回调 URL"),
    events: z.array(z.string()).optional().describe("监听的事件列表，如 ['note.created', 'note.updated']，默认为 ['*'] 接收所有"),
    description: z.string().optional().describe("描述"),
  },
  async ({ url, events, description }) => {
    try {
      const webhook = await api.createWebhook({ url, events, description });
      return { content: [{ type: "text" as const, text: `Webhook 创建成功!\nID: ${webhook.id}\nSecret: ${webhook.secret}\n\n请妥善保存 Secret，后续不会再显示。` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 审计日志工具 ====================

server.tool(
  "baseforge_audit_stats",
  "获取 BaseForge 的操作审计统计（按分类、级别统计，以及最近操作记录）（仅 unrestricted Token 可用）",
  {},
  async () => {
    try {
      const stats = await api.getAuditStats();
      let text = `📊 审计统计\n总记录: ${stats.total} | 今日: ${stats.todayCount}\n\n`;
      text += `按分类:\n`;
      for (const c of stats.byCategory || []) {
        text += `  ${c.category}: ${c.count}\n`;
      }
      text += `\n最近操作:\n`;
      for (const r of (stats.recent || []).slice(0, 5)) {
        text += `  [${r.level}] ${r.category}.${r.action} — ${r.createdAt}\n`;
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 备份工具 ====================

server.tool(
  "baseforge_list_backups",
  "获取 BaseForge 的数据备份列表（仅 unrestricted Token 可用）",
  {},
  async () => {
    try {
      const backups = await api.listBackups();
      if (backups.length === 0) {
        return { content: [{ type: "text" as const, text: "暂无备份" }] };
      }
      const text = backups.map(b =>
        `📦 ${b.filename}\n   大小: ${(b.size / 1024).toFixed(1)}KB | 类型: ${b.type} | 笔记: ${b.noteCount} | 时间: ${b.createdAt}`
      ).join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "baseforge_create_backup",
  "创建 BaseForge 数据备份。db-only 仅备份数据库，full 备份所有数据（仅 unrestricted Token 可用）",
  {
    type: z.enum(["db-only", "full"]).optional().describe("备份类型，默认 db-only"),
  },
  async ({ type }) => {
    try {
      const backup = await api.createBackup(type || "db-only");
      return { content: [{ type: "text" as const, text: `✅ 备份创建成功!\n文件: ${backup.filename}\n大小: ${(backup.size / 1024).toFixed(1)}KB\n笔记: ${backup.noteCount} 篇\n校验: ${backup.checksum}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 资源：笔记本列表 ====================

server.resource(
  "notebooks",
  "baseforge://notebooks",
  async (uri) => {
    const notebooks = await api.listNotebooks();
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(notebooks, null, 2),
      }],
    };
  }
);

// ==================== 启动 ====================

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`🚀 BaseForge MCP Server 已启动`);
  console.error(`   连接目标: ${config.baseUrl}`);
}

await main();
