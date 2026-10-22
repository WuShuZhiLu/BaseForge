import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, beforeEach } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  listPmOverview: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

import PmOverviewPage from "../PmOverviewPage";

const DEMO = {
  totals: {
    projects: 2,
    items: 6,
    byStatus: { todo: 3, doing: 1, review: 0, done: 2, canceled: 0 },
    byType: [
      { key: "requirement", label: "需求", count: 2 },
      { key: "task", label: "任务", count: 3 },
      { key: "bug", label: "缺陷", count: 1 },
    ],
    overdue: 1,
  },
  projects: [
    { id: "p1", name: "B端康复训练APP", color: "#2563EB", total: 4, done: 1, byStatus: { todo: 2, doing: 1, review: 0, done: 1, canceled: 0 }, overdue: 1 },
    { id: "p2", name: "C端康复系统小程序", color: "#8B5CF6", total: 2, done: 0, byStatus: { todo: 2, doing: 0, review: 0, done: 0, canceled: 0 }, overdue: 0 },
  ],
  overdueItems: [{ id: "i1", itemNo: 12, title: "校准-手部APP范式校准", dueDate: "2026-10-20", status: "todo", projectName: "B端康复训练APP" }],
  recent: [{ itemId: "i1", itemNo: 12, title: "校准-手部APP范式校准", field: "status", oldValue: "todo", newValue: "doing", createdAt: "2026-10-21T10:00:00.000Z" }],
};

describe("PmOverviewPage 渲染冒烟（复现空白页）", () => {
  beforeEach(() => {
    apiMocks.listPmOverview.mockReset().mockResolvedValue(DEMO);
  });

  it("真实形状数据渲染不抛错且出内容", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let renderError: unknown = null;
    try {
      await act(async () => {
        root.render(<PmOverviewPage onOpenProject={() => {}} />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    } catch (err) {
      renderError = err;
    }
    expect(renderError).toBeNull();
    expect(host.textContent).toContain("各项目进度");
    expect(host.textContent).toContain("B端康复训练APP");
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
