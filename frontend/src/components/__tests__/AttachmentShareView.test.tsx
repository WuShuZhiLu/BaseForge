import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentShareView from "@/components/AttachmentShareView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  meta: vi.fn(),
  verify: vi.fn(),
  fetchContent: vi.fn(),
  contentUrl: vi.fn((token: string) => `http://localhost:3001/api/attachment-shares/${token}/content`),
}));

vi.mock("@/lib/attachmentShareApi", () => ({
  attachmentSharePublicApi: {
    meta: mocks.meta,
    verify: mocks.verify,
    fetchContent: mocks.fetchContent,
    contentUrl: mocks.contentUrl,
  },
}));

const meta = {
  id: "share-1",
  filename: "季度报表.pdf",
  mimeType: "application/octet-stream",
  size: 32,
  needPassword: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-11-01 08:19:41",
};

async function flushEffects(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

function findButton(host: HTMLElement, text: string) {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}

/** 受控 input 必须走原生 setter，否则 React 的 onChange 拿不到新值。 */
async function typePassword(host: HTMLElement, value: string) {
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function clickVerify(host: HTMLElement) {
  await act(async () => {
    findButton(host, "验证并查看")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await flushEffects();
}

describe("AttachmentShareView", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.meta.mockReset();
    mocks.verify.mockReset();
    mocks.fetchContent.mockReset();
    mocks.verify.mockResolvedValue({ success: true, accessToken: "visitor-jwt" });
    mocks.fetchContent.mockResolvedValue(new Blob(["payload"], { type: "application/octet-stream" }));
    // jsdom 的 URL 没有 blob 实现，预览/下载都靠它
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:fake/preview");
      static revokeObjectURL = vi.fn();
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    // 反序会踩坑：unmount 的 effect cleanup 要 revoke blob URL，得等它跑完再还原全局
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("opens a password-less share straight into preview + download", async () => {
    mocks.meta.mockResolvedValue(meta);

    await act(async () => { root.render(<AttachmentShareView shareToken="tok123" />); });
    await flushEffects();

    expect(host.textContent).toContain("季度报表.pdf");
    expect(host.textContent).toContain("该文件类型不支持在线预览");
    // 无密码访客仍然走 verify 取短期凭证，content 只有这一条读取路径
    expect(mocks.verify).toHaveBeenCalledWith("tok123");
    expect(findButton(host, "下载文件")).toBeTruthy();
  });

  it("shows the password gate and unlocks after verify", async () => {
    mocks.meta.mockResolvedValue({ ...meta, needPassword: true });

    await act(async () => { root.render(<AttachmentShareView shareToken="tok123" />); });
    await flushEffects();

    expect(host.textContent).toContain("这份分享需要密码");
    // 带密码的链接不能在门后就签凭证
    expect(mocks.verify).not.toHaveBeenCalled();

    const input = host.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    // 错密码：留在门内，并把后端的 403 文案透出来
    mocks.verify.mockRejectedValueOnce(Object.assign(new Error("访问密码错误"), { status: 403 }));
    await typePassword(host, "wrong");
    await clickVerify(host);

    expect(mocks.verify).toHaveBeenLastCalledWith("tok123", "wrong");
    expect(host.textContent).toContain("访问密码错误");

    await typePassword(host, "test1234");
    await clickVerify(host);

    expect(host.textContent).toContain("季度报表.pdf");
  });

  it("previews images automatically but loads PDF only on demand", async () => {
    mocks.meta.mockResolvedValue({ ...meta, filename: "现场照片.png", mimeType: "image/png" });

    await act(async () => { root.render(<AttachmentShareView shareToken="tok-image" />); });
    await flushEffects();

    // 图片是访客页最常见情形，进 ready 就直接拉，不再要求点击
    expect(mocks.fetchContent).toHaveBeenCalledWith("tok-image", "visitor-jwt");
    expect(host.querySelector("img")).not.toBeNull();

    // PDF 体积可能很大，不能一进页面就整份拉到内存
    act(() => root.unmount());
    mocks.fetchContent.mockClear();
    mocks.meta.mockResolvedValue({ ...meta, mimeType: "application/pdf" });
    root = createRoot(host);

    await act(async () => { root.render(<AttachmentShareView shareToken="tok-pdf" />); });
    await flushEffects();

    expect(mocks.fetchContent).not.toHaveBeenCalled();
    expect(host.textContent).toContain("确认后再加载");

    await act(async () => {
      findButton(host, "在线预览")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flushEffects();

    expect(mocks.fetchContent).toHaveBeenCalledWith("tok-pdf", "visitor-jwt");
    expect(host.querySelector("iframe")).not.toBeNull();
  });

  it("renders one generic invalid state for a revoked or expired link", async () => {
    mocks.meta.mockRejectedValue(Object.assign(new Error("分享链接不存在或已失效"), { status: 404 }));

    await act(async () => { root.render(<AttachmentShareView shareToken="tok123" />); });
    await flushEffects();

    expect(host.textContent).toContain("链接不存在或已失效");
    // 后端把四种失效原因统一成 404，页面也只给一个通用态（不说“这个链接已过期”）
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("surfaces the rate-limited message instead of a raw error", async () => {
    mocks.meta.mockResolvedValue({ ...meta, needPassword: true });
    mocks.verify.mockRejectedValue(Object.assign(new Error("验证尝试过于频繁，请稍后再试"), { status: 429 }));

    await act(async () => { root.render(<AttachmentShareView shareToken="tok123" />); });
    await flushEffects();

    await typePassword(host, "test1234");
    await clickVerify(host);

    expect(host.textContent).toContain("验证尝试过于频繁，请稍后再试");
    expect(host.textContent).not.toContain("链接不存在或已失效");
  });
});
