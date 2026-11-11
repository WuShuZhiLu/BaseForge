import { describe, expect, it } from "vitest";
import { preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";
import { markdownToPlainText, markdownToTiptapJSON, tiptapJsonToMarkdown } from "@/lib/contentFormat";
import { buildBoardEmbedMarkdown, parseBoardEmbedHref } from "@/lib/boardEmbed";

const ID = "22222222-2222-4222-8222-222222222222";
const source = `![[board:${ID}]]`;

describe("board document embeds", () => {
  it("parses and builds a stable board reference", () => {
    expect(parseBoardEmbedHref(`board:${ID}`)).toBe(ID);
    expect(parseBoardEmbedHref(`board:${ID.toUpperCase()}`)).toBe(ID);
    expect(parseBoardEmbedHref("board:not-a-uuid")).toBeNull();
    expect(parseBoardEmbedHref(`note:${ID}`)).toBeNull();
    expect(buildBoardEmbedMarkdown(ID)).toBe(source);
    expect(buildBoardEmbedMarkdown("not-a-uuid")).toBeNull();
  });

  it("preprocesses to a block embed placeholder without leaking API paths", () => {
    const rendered = preprocessInternalNoteLinks(source);
    expect(rendered).toContain(`data-baseforge-block-embed="board:${ID}"`);
    expect(rendered).not.toContain("/api/");
  });

  it("does not interpret a board embed in fenced code", () => {
    expect(preprocessInternalNoteLinks(`\`\`\`markdown\n${source}\n\`\`\``)).toContain(source);
  });

  it("round-trips through Markdown ⇄ Tiptap", () => {
    const document = markdownToTiptapJSON(`前文\n\n${source}\n\n后文`);
    const embedded = document.content.find(
      (node: import("@tiptap/core").JSONContent) => node.type === "blockEmbed",
    );
    expect(embedded?.attrs?.href).toBe(`board:${ID}`);
    expect(tiptapJsonToMarkdown(document)).toContain(source);
  });

  it("keeps a readable placeholder without exposing the note id", () => {
    const text = markdownToPlainText(source);
    expect(text).toContain("画板");
    expect(text).not.toContain(ID);
  });
});
