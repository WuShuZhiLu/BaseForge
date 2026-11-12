import { describe, expect, it } from "vitest";
import { buildWikiNoteLink, detectActiveWikiNoteQuery, parseInternalNoteHref, parseNoteLinkQuery, preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";

const ID = "11111111-1111-4111-8111-111111111111";

describe("note link syntax", () => {
  it("splits search title and fixed alias", () => {
    expect(parseNoteLinkQuery("目标笔记|我的别名")).toEqual({ searchText: "目标笔记", alias: "我的别名" });
  });
  it("builds and parses stable block links", () => {
    const source = buildWikiNoteLink(ID, "blk_target", "别名");
    expect(source).toBe(`[[note:${ID}#blk:blk_target|别名]]`);
    expect(parseInternalNoteHref(`note:${ID}#blk:blk_target`)).toEqual({ noteId: ID, blockId: "blk_target" });
  });
  it("detects an active CodeMirror wiki query", () => {
    expect(detectActiveWikiNoteQuery("文字 [[目标|别名", 20, 3)).toEqual({ query: "目标|别名", from: 6, to: 20 });
    expect(detectActiveWikiNoteQuery("文字 【【目标|别名", 20, 3)).toEqual({ query: "目标|别名", from: 6, to: 20 });
  });
  it("uses the latest wiki trigger and stops after either closing bracket pair", () => {
    expect(detectActiveWikiNoteQuery("[[旧 【【新", 7, 0)).toEqual({ query: "新", from: 4, to: 7 });
    expect(detectActiveWikiNoteQuery("【【目标】】", 6, 0)).toBeNull();
    expect(detectActiveWikiNoteQuery("[[目标]]", 6, 0)).toBeNull();
  });
  it("preprocesses links and embeds but preserves fenced code", () => {
    const md = `[[note:${ID}]]\n\n![[note:${ID}#blk:blk_target]]\n\n\`\`\`md\n[[note:${ID}]]\n\`\`\``;
    const html = preprocessInternalNoteLinks(md);
    expect(html).toContain("data-baseforge-title-mode=\"auto\"");
    expect(html).toContain("data-baseforge-block-embed");
    expect(html).toContain(`\`\`\`md\n[[note:${ID}]]`);
  });
  it("converts mind map embeds to block-embed placeholders, including fenced code", () => {
    const md = `前文\n\n![[mindmap:${ID}]]\n\n\`\`\`md\n![[mindmap:${ID}]]\n\`\`\``;
    const html = preprocessInternalNoteLinks(md);
    expect(html).toContain(`<div data-baseforge-block-embed="mindmap:${ID}"></div>`);
    expect(html).toContain(`\`\`\`md\n![[mindmap:${ID}]]`);
  });
});
