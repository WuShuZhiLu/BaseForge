import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { it, vi } from "vitest";
const copyTextMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText: copyTextMock }));
import { CodeBlockView } from "@/components/CodeBlockView";
it("probe", async () => {
  const editor = { isEditable: true, isDestroyed: false, on() {}, off() {} };
  const props = { node: { attrs: { language: "javascript", blockId: "b", indent: 0 }, textContent: "x" }, editor, extension: { options: { lowlight: { listLanguages: () => [] } } }, updateAttributes: vi.fn(), getPos: () => 1 } as any;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<CodeBlockView {...props} />); });
  const btns = [...container.querySelectorAll("button")].map(b => b.getAttribute("title"));
  console.log("PROBE_TITLES:", JSON.stringify(btns));
  
});
