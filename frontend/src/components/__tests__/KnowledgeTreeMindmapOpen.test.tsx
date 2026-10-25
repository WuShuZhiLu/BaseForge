// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const MINDMAP_ID = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/knowledgeTreeApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/knowledgeTreeApi")>("@/lib/knowledgeTreeApi");
  // 导图归一后是 contentFormat="mindmap" 的笔记节点（resourceType="note"）。
  // 注意：vi.mock 工厂会被提升，不能用文件内常量。
  const node = {
    id: `note:22222222-2222-4222-8222-222222222222`,
    userId: "u1",
    workspaceId: null,
    scopeKey: "personal",
    parentId: null,
    nodeType: "note",
    resourceType: "note",
    resourceId: "22222222-2222-4222-8222-222222222222",
    sortOrder: 0,
    isExpanded: 0,
    isDeleted: 0,
    deletedAt: null,
    createdAt: "2026-10-13 00:00:00",
    updatedAt: "2026-10-13 00:00:00",
    title: "无标题导图",
    icon: null,
    contentFormat: "mindmap",
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
  // 记录调用的 actions 代理，供断言 setActiveNote 被携带导图文档调用。
  const actionsProxy: Record<string, ReturnType<typeof vi.fn>> = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (target, prop) => {
      if (typeof prop !== "string") return undefined;
      target[prop] ??= vi.fn();
      return target[prop];
    },
  });
  const state = { viewMode: "all", activeNote: null, searchQuery: "", mobileView: "list", editorSplit: false, notes: [], notebooks: [], tags: [] };
  return { ...actual, useApp: () => ({ state, actions: actionsProxy }), useAppActions: () => actionsProxy, __actionsProxy: actionsProxy };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      getNote: vi.fn().mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
        userId: "u1",
        notebookId: "nb-1",
        workspaceId: null,
        title: "无标题导图",
        content: JSON.stringify({ root: { id: "root", text: "无标题导图", children: [] } }),
        contentText: "",
        contentFormat: "mindmap",
        isPinned: 0,
        isFavorite: 0,
        isLocked: 0,
        isArchived: 0,
        isTrashed: 0,
        version: 1,
        createdAt: "2026-10-13 00:00:00",
        updatedAt: "2026-10-13 00:00:00",
      }),
    },
  };
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
 * 回归：知识树里的导图文档节点必须能点开。
 *
 * 导图归一后是 contentFormat="mindmap" 的笔记节点（resourceType="note"），
 * 点击走通用笔记打开链路（api.getNote → setActiveNote），不再跳 /mindmaps/:id 深链。
 */
it("opens a mind map doc as a note from the knowledge tree", async () => {
  await act(async () => {
    root.render(<MobileKnowledgeTreePanel variant="desktop" />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  const row = host.querySelector(`[data-desktop-knowledge-tree-node-id="note:${MINDMAP_ID}"]`);
  expect(row).not.toBeNull();
  const button = row?.querySelector("button");
  expect(button).not.toBeNull();

  await act(async () => {
    button!.click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const { api } = await import("@/lib/api");
  expect(vi.mocked(api.getNote)).toHaveBeenCalledWith(MINDMAP_ID);
  const appContextModule = await import("@/store/AppContext");
  const actionsProxy = (appContextModule as unknown as { __actionsProxy: Record<string, ReturnType<typeof vi.fn>> }).__actionsProxy;
  expect(actionsProxy.setActiveNote).toHaveBeenCalled();
  const activated = actionsProxy.setActiveNote.mock.calls[0]?.[0] as { id?: string } | undefined;
  expect(activated?.id).toBe(MINDMAP_ID);
  // 不再跳导图模块深链
  expect(window.location.pathname.endsWith(`/mindmaps/${MINDMAP_ID}`)).toBe(false);
});
