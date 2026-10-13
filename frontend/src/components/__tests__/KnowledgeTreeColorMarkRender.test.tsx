// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// vi.mock 的工厂会被提升到文件顶部，测试数据必须走 vi.hoisted。
const { nodes } = vi.hoisted(() => {
  const base = {
    userId: "u1",
    workspaceId: null,
    scopeKey: "personal",
    sortOrder: 0,
    isDeleted: 0,
    deletedAt: null,
    createdAt: "2026-10-13 00:00:00",
    updatedAt: "2026-10-13 00:00:00",
    icon: null,
    access: { capabilities: { canRead: true, canCreate: false, canMove: false, canDelete: false, canRename: false, canShare: false }, inherited: true },
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
  };
  return {
    nodes: [
      { ...base, id: "folder-1", parentId: null, nodeType: "folder", resourceType: "notebook", resourceId: "nb1", isExpanded: 1, title: "资料", contentFormat: null, colorMark: null, childCount: 2 },
      { ...base, id: "note-colored", parentId: null, nodeType: "document", resourceType: "note", resourceId: "note-1", isExpanded: 0, title: "1", contentFormat: "tiptap-json", colorMark: "purple", childCount: 0 },
      { ...base, id: "note-plain", parentId: null, nodeType: "document", resourceType: "note", resourceId: "note-2", isExpanded: 0, title: "无颜色", contentFormat: "tiptap-json", colorMark: null, childCount: 0 },
    ],
  };
});

vi.mock("@/lib/knowledgeTreeApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/knowledgeTreeApi")>("@/lib/knowledgeTreeApi");
  return {
    ...actual,
    knowledgeTreeApi: {
      ...actual.knowledgeTreeApi,
      list: vi.fn().mockResolvedValue({ nodes }),
      listShared: vi.fn().mockResolvedValue({ nodes: [] }),
    },
  };
});

vi.mock("@/store/AppContext", async () => {
  const actual = await vi.importActual<typeof import("@/store/AppContext")>("@/store/AppContext");
  const actions = new Proxy({}, { get: () => vi.fn() });
  const state = {
    viewMode: "all",
    activeNote: null,
    searchQuery: "",
    mobileView: "list",
    editorSplit: false,
    notes: [],
    notebooks: [],
    tags: [],
  };
  return { ...actual, useApp: () => ({ state, actions }), useAppActions: () => actions };
});

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

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
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/**
 * 回归：色标必须在「快捷目录（desktop 变体，也就是桌面侧栏默认那棵树）」里真的渲染成 DOM。
 *
 * 之前两处断链都会导致"改了颜色看不到"：
 *   1) 树接口没返回 colorMark（后端 SELECT 少一列）→ 组件拿到 undefined，圆点直接不渲染；
 *   2) 面板根本没渲染 NoteColorMarkDot（只接了标签栏）。
 * 这里把带 colorMark 的节点直接喂给面板，断言 DOM 里存在紫色圆点。
 */
it("renders a colored dot for a note node in the desktop quick tree", async () => {
  await act(async () => {
    root.render(<MobileKnowledgeTreePanel variant="desktop" />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  // 色标只保留竖线（用户裁定去掉圆点）。
  expect(host.querySelectorAll("[data-note-color-mark]")).toHaveLength(0);

  const bars = host.querySelectorAll("[data-note-color-mark-bar]");
  expect(bars).toHaveLength(1);
  expect(bars[0].getAttribute("data-note-color-mark-bar")).toBe("purple");
  expect((bars[0] as HTMLElement).style.backgroundColor).toBe("rgb(168, 85, 247)");

  const plainRow = host.querySelector('[data-desktop-knowledge-tree-node-id="note-plain"]');
  expect(plainRow?.querySelector("[data-note-color-mark-bar]") ?? null).toBeNull();
});
