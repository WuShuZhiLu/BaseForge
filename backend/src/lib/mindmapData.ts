/**
 * MindMapData 纯函数工具（导图归一知识库文档后各链路共用）。
 *
 * 归一后导图正文存 notes.content（contentFormat = "mindmap"），结构：
 *   { root: { id: "root", text: "...", children: [ ... ] } }
 */

/** 默认初始正文：单个根节点，文本取标题。 */
export function defaultMindmapContent(title: string): string {
  return JSON.stringify({ root: { id: "root", text: title, children: [] } });
}

/** 遍历导图 JSON 收集节点文本；兼容把 root 平铺在顶层的历史数据。 */
export function collectMindmapTexts(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "") as { root?: unknown };
    const root = parsed && typeof parsed === "object" && "root" in parsed ? parsed.root : parsed;
    const values: string[] = [];
    const stack: unknown[] = root ? [root] : [];
    let visited = 0;
    while (stack.length > 0 && visited < 20_000) {
      const current = stack.pop();
      visited += 1;
      if (!current || typeof current !== "object" || Array.isArray(current)) continue;
      const node = current as { text?: unknown; children?: unknown };
      if (typeof node.text === "string" && node.text) values.push(node.text);
      if (Array.isArray(node.children)) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          stack.push(node.children[index]);
        }
      }
    }
    return values;
  } catch {
    return [];
  }
}

/** 节点文本合并为可检索的一行文本（contentText / 派生搜索文本用）。 */
export function mindmapPlainText(raw: string | null | undefined): string {
  return collectMindmapTexts(raw).join(" ").replace(/\s+/g, " ").trim();
}
