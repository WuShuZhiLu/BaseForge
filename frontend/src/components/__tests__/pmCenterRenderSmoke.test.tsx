import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, beforeEach } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => {
  const fn = () => vi.fn().mockResolvedValue({});
  return {
    listPmProjects: vi.fn().mockResolvedValue({ projects: [{ id: "p1", userId: "u", name: "1", description: "", color: "#2563EB", workspaceId: null, typeConfig: [{ key: "requirement", label: "需求", color: "#0ea5e9" }], createdAt: "", updatedAt: "" }] }),
    createPmProject: fn,
    updatePmProject: vi.fn().mockResolvedValue({ project: {} }),
    deletePmProject: vi.fn().mockResolvedValue({ success: true }),
    listPmWorkItems: vi.fn().mockResolvedValue({ items: [{ id: "i1", userId: "u", projectId: "p1", type: "requirement", title: "测试工单", description: "", status: "todo", priority: "medium", dueDate: null, notebookId: null, noteId: null, gitRepo: null, gitBranch: null, gitIssue: null, gitSourceId: null, gitIssueState: null, gitIssueUrl: null, itemNo: 1, parentId: null, tags: [], sortOrder: 0, createdAt: "", updatedAt: "" }], stats: { todo: 1, doing: 0, review: 0, done: 0, canceled: 0 } }),
    createPmWorkItem: fn,
    updatePmWorkItem: vi.fn().mockResolvedValue({ item: {} }),
    deletePmWorkItem: fn,
    pullPmItem: fn,
    pushPmItem: fn,
    listPmItemLogs: vi.fn().mockResolvedValue({ logs: [] }),
    listPmItemNotes: vi.fn().mockResolvedValue({ notes: [] }),
    addPmItemNote: vi.fn().mockResolvedValue({ duplicate: false }),
    removePmItemNote: vi.fn().mockResolvedValue({ success: true, wasPrimary: false }),
    listPmOverview: vi.fn().mockResolvedValue({ totals: { projects: 1, items: 1, byStatus: { todo: 1 }, byType: [{ key: "requirement", label: "需求", count: 1 }], overdue: 0 }, projects: [{ id: "p1", name: "1", color: "#2563EB", total: 1, done: 0, byStatus: { todo: 1 }, overdue: 0 }], overdueItems: [], recent: [] }),
  };
});

vi.mock("@/lib/api", () => ({ api: apiMocks }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, opts?: unknown) => (typeof opts === "string" ? opts : (opts as { defaultValue?: string } | undefined)?.defaultValue ?? key) }) }));
vi.mock("@/components/MarkdownPreview", () => ({ MarkdownPreview: () => null }));

import PmCenter from "../PmCenter";

describe("PmCenter 渲染冒烟（复现空白页）", () => {
  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) {
      if (typeof mock === "function" && typeof (mock as { mockReset?: unknown }).mockReset === "function") continue;
    }
  });

  it("viewMode=projects + overview 模块渲染不抛错", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let renderError: unknown = null;
    try {
      await act(async () => {
        root.render(<PmCenter />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    } catch (err) {
      renderError = err;
    }
    expect(renderError).toBeNull();
    expect(host.textContent!.length).toBeGreaterThan(0);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
