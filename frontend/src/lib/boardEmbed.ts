/**
 * 画板嵌入引用（![[board:<noteId>]]）的纯函数工具。
 *
 * 与 mindmap/sheet 嵌入同属 wiki 引用管线：文档里只存稳定 ID，
 * 场景数据仍以画板笔记为唯一真源，删除嵌入块不会删除画板。
 * 单独成文件是为了让解析/构造可在 node 环境直接单测，不拖入 React 组件。
 */
const BOARD_HREF_RE = /^board:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function parseBoardEmbedHref(href: string): string | null {
  return BOARD_HREF_RE.exec((href || "").trim())?.[1].toLowerCase() || null;
}

export function buildBoardEmbedMarkdown(id: string): string | null {
  const normalized = parseBoardEmbedHref(`board:${id}`);
  return normalized ? `![[board:${normalized}]]` : null;
}
