import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShareManagementPage from "@/components/ShareManagementPage";
import { setShareCenterUi } from "@/features/shares/shareCenterUi";
import type { ShareCenterItem, ShareCenterResponse } from "@/lib/shareCenter";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  batch: vi.fn(),
  visits: vi.fn(),
  getMe: vi.fn(),
  updateShare: vi.fn(),
  deleteShare: vi.fn(),
  getNote: vi.fn(),
  attachmentUpdate: vi.fn(),
  updatePublicWebOrigin: vi.fn(),
  copyText: vi.fn(),
  openToolTab: vi.fn(),
  siteConfig: {
    publicWebOrigin: "https://note.example.com",
    publicWebOriginSource: "settings",
  },
}));

// shareCenter.ts 的标签/格式化函数用真实实现，只替换网络层。
vi.mock("@/lib/shareCenter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shareCenter")>();
  return { ...actual, shareCenterApi: { list: mocks.list, batch: mocks.batch, visits: mocks.visits } };
});
vi.mock("@/lib/api", () => ({
  api: {
    getMe: mocks.getMe,
    updateShare: mocks.updateShare,
    deleteShare: mocks.deleteShare,
    getNote: mocks.getNote,
  },
}));
vi.mock("@/lib/attachmentShareApi", () => ({
  attachmentShareApi: { update: mocks.attachmentUpdate },
}));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("@/store/AppContext", () => ({
  // 页面「分享当前笔记」要读 activeNote，没有打开的笔记时走提示分支。
  useApp: () => ({ state: { activeNote: null } }),
  useAppActions: () => ({ setActiveNote: vi.fn(), setViewMode: vi.fn(), setMobileView: vi.fn(), openToolTab: mocks.openToolTab }),
}));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({
    siteConfig: mocks.siteConfig,
    updatePublicWebOrigin: mocks.updatePublicWebOrigin,
  }),
}));
vi.mock("@/components/ShareModal", () => ({ default: () => null }));
vi.mock("@/components/ui/confirm", () => ({ confirm: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

function makeItem(overrides: Partial<ShareCenterItem>): ShareCenterItem {
  return {
    id: "share-1",
    channel: "note_share",
    objectKind: "note",
    objectId: "note-1",
    title: "我的公开笔记",
    objectPath: "工作 / 我的公开笔记",
    token: "abcdefghijklmnopqr",
    urlPath: "/s/abcdefghijklmnopqr",
    access: "password",
    permission: "view",
    hasPassword: true,
    isActive: true,
    viewCount: 2,
    maxViews: 10,
    lastSeenAt: null,
    expiresAt: null,
    createdAt: "2026-07-20T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    objectMissing: false,
    objectTrashed: false,
    status: "active",
    risks: [],
    capabilities: null,
    ...overrides,
  };
}

const noteItem = makeItem({});
const fileItem = makeItem({
  id: "fs-1",
  channel: "file_share",
  objectKind: "file",
  objectId: "att-1",
  title: "季度报表.pdf",
  objectPath: "文件 / 季度报表.pdf",
  urlPath: "/fs/abcdefghijklmnopqr",
  access: "link",
  permission: "download",
  hasPassword: false,
  viewCount: null,
  maxViews: null,
  risks: ["open_ended"],
});
const orphanItem = makeItem({
  id: "share-2",
  objectId: "note-2",
  title: "删掉的笔记",
  isActive: true,
  objectMissing: true,
  status: "orphan",
  risks: ["orphan"],
});

const response: ShareCenterResponse = {
  items: [noteItem, fileItem, orphanItem],
  total: 3,
  page: 1,
  pageSize: 50,
  counts: {
    total: 3,
    groups: { active: 2, attention: 1, disabled: 0 },
    statuses: { active: 2, disabled: 0, expired: 0, exhausted: 0, orphan: 1 },
    objects: { note: 2, file: 1, notebook: 0 },
    risks: { open_ended: 1, orphan: 1, unused: 0, bare: 2 },
  },
  bareAttachmentUrls: { count: 4, revocable: false },
};

async function flushEffects(rounds = 4) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

function findButtonByText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await flushEffects();
}

/** 分类与 chips 存在 localStorage 里，用例之间必须清掉，否则会互相污染。 */
async function pickFilter(patch: Parameters<typeof setShareCenterUi>[0]) {
  await act(async () => {
    setShareCenterUi(patch);
    await Promise.resolve();
  });
  await flushEffects();
}

describe("ShareManagementPage", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    mocks.list.mockReset();
    mocks.list.mockResolvedValue(response);
    mocks.batch.mockReset();
    mocks.batch.mockResolvedValue({ succeeded: 1, failed: 0, requested: 1 });
    mocks.visits.mockReset();
    mocks.visits.mockResolvedValue({ total: 0, visits: [], supported: true });
    mocks.getMe.mockReset();
    mocks.getMe.mockResolvedValue({ role: "admin" });
    mocks.updateShare.mockReset();
    mocks.deleteShare.mockReset();
    mocks.getNote.mockReset();
    mocks.attachmentUpdate.mockReset();
    mocks.updatePublicWebOrigin.mockReset();
    mocks.updatePublicWebOrigin.mockResolvedValue(undefined);
    mocks.copyText.mockReset();
    mocks.copyText.mockResolvedValue(true);
    mocks.openToolTab.mockReset();
    mocks.siteConfig.publicWebOrigin = "https://note.example.com";
    mocks.siteConfig.publicWebOriginSource = "settings";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("列出全部通道，标题与页脚计数取后端同源 total", async () => {
    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    expect(mocks.list).toHaveBeenCalledTimes(1);
    // 原型标题行：分类名 + 条数（条数来自列表 total，与列表同源）
    expect(host.textContent).toContain("全部分享");
    expect(host.textContent).toContain("3 条");
    // 三条通道同表渲染：不计数通道显示「此通道不计数」而不是谎报 0 次
    expect(host.textContent).toContain("我的公开笔记");
    expect(host.textContent).toContain("季度报表.pdf");
    expect(host.textContent).toContain("删掉的笔记");
    expect(host.textContent).toContain("已设密码");
    expect(host.textContent).toContain("原对象已失效");
    expect(host.textContent).toContain("此通道不计数");
    // 页脚：原型「共 N 条，第 x / y 页 · 其中 M 条无密码且永久」
    expect(host.textContent).toContain("共 3 条，第 1 / 1 页");
    expect(host.textContent).toContain("其中 1 条无密码且永久");
    // 原型工具行：6 个快捷 chips + 排序
    for (const label of ["全部", "仅查看", "可评论", "可编辑", "有密码", "7 天内到期"]) {
      expect(findButtonByText(host, label)).toBeTruthy();
    }
    // 默认排序对齐原型「最近访问」，是个文字下拉而不是原生 select
    expect(host.textContent).toContain("排序：最近访问");
  });

  it("对象图标按文件类型分开，不把每个文件都画成回形针", async () => {
    mocks.list.mockResolvedValue({
      ...response,
      items: [
        { ...fileItem, id: "fs-pdf", title: "季度报表.pdf" },
        { ...fileItem, id: "fs-jpg", title: "0089KBGPgy1i2imiyhwv4j.jpg" },
        { ...fileItem, id: "fs-bin", title: "installer" },
        noteItem,
      ],
      total: 4,
    });
    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    // pdf 橙色、图片紫色、无扩展名回形针：一行一个形状，不再整列同一个图标
    expect(host.querySelectorAll('[class*="bg-orange-500/12"]').length).toBe(1);
    expect(host.querySelectorAll('[class*="bg-violet-500/12"]').length).toBe(1);
    expect(host.querySelector("svg.lucide-image")).not.toBeNull();
    expect(host.querySelectorAll("svg.lucide-paperclip").length).toBe(1);
    // 笔记/文件标签按原型用蓝/紫底色，而不是统一的灰描边（只在表格里找，快捷 chips 也用同一个蓝）
    const table = host.querySelector("table")!;
    expect(table.querySelectorAll('[class*="bg-[#e8efff]"]').length).toBe(1);
    expect(table.querySelectorAll('[class*="bg-[#f3e8ff]"]').length).toBe(3);
  });

  it("左栏分类与主区共用同一份筛选状态", async () => {
    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    // 侧栏点「需要处理」= 写共享 store，主区标题与请求跟着变
    await pickFilter({ group: "attention" });

    expect(host.textContent).toContain("需要处理");
    expect(mocks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ group: "attention", page: 1 }),
    );
  });

  it("快捷 chips 落到后端已有参数上，再点一次回到全部", async () => {
    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    await click(findButtonByText(host, "仅查看")!);
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ permission: "view" }));

    await click(findButtonByText(host, "有密码")!);
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ hasPassword: true }));

    await click(findButtonByText(host, "7 天内到期")!);
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ expiresWithinDays: 7 }));

    // 单选：再点同一个 chip 取消，请求里不再带该维度
    await click(findButtonByText(host, "7 天内到期")!);
    const lastCall = mocks.list.mock.calls.at(-1)![0];
    expect(lastCall).not.toHaveProperty("expiresWithinDays");
    expect(lastCall).not.toHaveProperty("permission");
  });

  it("批量条按原型形态驱动 share-center 批量接口", async () => {
    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    // 勾选列默认不显示：先点右上角「选择」进入多选态（与文件管理同一交互）
    expect(host.querySelector('input[aria-label="选择 我的公开笔记"]')).toBeNull();
    await click(findButtonByText(host, "选择")!);

    const checkbox = host.querySelector('input[aria-label="选择 我的公开笔记"]') as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    await act(async () => {
      checkbox!.click();
      await Promise.resolve();
    });
    await flushEffects();

    expect(host.textContent).toContain("已选 1 项");
    // 原型批量条四个动作都在
    for (const label of ["批量停用", "批量设过期（30 天后）", "批量复制全部链接", "批量删除", "取消"]) {
      expect(findButtonByText(host, label)).toBeTruthy();
    }

    await click(findButtonByText(host, "批量停用")!);

    expect(mocks.batch).toHaveBeenCalledWith(
      "disable",
      [{ channel: "note_share", id: "share-1" }],
      undefined,
    );
    // 批量后清空选择并静默刷新
    expect(host.textContent).not.toContain("已选 1 项");
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("没有数据时渲染空态", async () => {
    mocks.list.mockResolvedValue({
      total: 0,
      page: 1,
      pageSize: 50,
      counts: {
        total: 0,
        groups: { active: 0, attention: 0, disabled: 0 },
        statuses: { active: 0, disabled: 0, expired: 0, exhausted: 0, orphan: 0 },
        objects: { note: 0, file: 0, notebook: 0 },
        risks: { open_ended: 0, orphan: 0, unused: 0, bare: 0 },
      },
      bareAttachmentUrls: { count: 0, revocable: false },
    });

    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    expect(host.textContent).toContain("还没有符合条件的分享链接");
  });
});
