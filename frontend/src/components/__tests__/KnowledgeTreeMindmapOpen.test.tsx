// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const MINDMAP_ID = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/knowledgeTreeApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/knowledgeTreeApi")>("@/lib/knowledgeTreeApi");
  const node = {
    id: "tree-mindmap",
    userId: "u1",
    workspaceId: null,
    scopeKey: "personal",
    parentId: null,
    nodeType: "mindmap",
    resourceType: "mindmap",
    resourceId: "22222222-2222-4222-8222-222222222222",
    sortOrder: 0,
    isExpanded: 0,
    isDeleted: 0,
    deletedAt: null,
    createdAt: "2026-10-13 00:00:00",
    updatedAt: "2026-10-13 00:00:00",
    title: "无标题导图",
    icon: null,
    contentFormat: null,
    colorMark: null,
    childCount: 0,
    access: { capabilities: { canRead: true, canCreate: false, canMove: false, canDelete: false, canRename: false, canShare: false }, inherited: true },
  };
  return {
    ...actual,
    knowledgeTreeApi: {
      ...actual.knowledgeTreeApi,
      list: vi.fn().mockResolvedValue({ nodes: [node] }),
      listShared: vi.fn().mockResolvedValue({ nodes: [] }),
    },
  };
});

vi.mock("@/store/AppContext", async () => {
  const actual = await vi.importActual<typeof import("@/store/AppContext")>("@/store/AppContext");
  const actions = new Proxy({}, { get: () => vi.fn() });
  const state = { viewMode: "all", activeNote: null, searchQuery: "", mobileView: "list", editorSplit: false, notes: [], notebooks: [], tags: [] };
  return { ...actual, useApp: () => ({ state, actions }), useAppActions: () => actions };
});

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/ui/confirm", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  prompt: vi.fn().mockResolvedValue(null),
  choose: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/components/YuqueImport", () => ({ default: () => null }));

import MobileKnowledgeTreePanel from "@/components/MobileKnowledgeTreePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.history.replaceState(null, "", "/");
});

/**
 * 回归：知识树里的思维导图节点必须能点开。
 *
 * openDocument 里曾经只处理 folder / sheet / note，mindmap 落到
 * `if (node.resourceType !== "note") return;` 被静默丢弃 —— 点「无标题导图」毫无反应、
 * URL 也不动。修法是照上游走导图深链 pushMindMapAppPath。
 */
it("opens a mind map node by pushing the mind map deep link", async () => {
  await act(async () => {
    root.render(<MobileKnowledgeTreePanel variant="desktop" />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  const row = host.querySelector('[data-desktop-knowledge-tree-node-id="tree-mindmap"]');
  expect(row).not.toBeNull();
  const button = row?.querySelector("button");
  expect(button).not.toBeNull();

  await act(async () => {
    button!.click();
  });

  expect(window.location.pathname.endsWith(`/mindmaps/${MINDMAP_ID}`)).toBe(true);
});
