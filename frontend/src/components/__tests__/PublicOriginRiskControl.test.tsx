import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicOriginRiskControl } from "@/components/PublicOriginRiskControl";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getMe: vi.fn(),
  updatePublicWebOrigin: vi.fn(),
  copyText: vi.fn(),
  siteConfig: {
    publicWebOrigin: "https://note.example.com",
    publicWebOriginSource: "settings",
  },
}));

vi.mock("@/lib/api", () => ({ api: { getMe: mocks.getMe } }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({
    siteConfig: mocks.siteConfig,
    updatePublicWebOrigin: mocks.updatePublicWebOrigin,
  }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

async function flushEffects(rounds = 4) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

function findButtonByText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}

describe("PublicOriginRiskControl", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.getMe.mockReset();
    mocks.getMe.mockResolvedValue({ role: "admin" });
    mocks.updatePublicWebOrigin.mockReset();
    mocks.updatePublicWebOrigin.mockResolvedValue(undefined);
    mocks.copyText.mockReset();
    mocks.copyText.mockResolvedValue(true);
    mocks.siteConfig.publicWebOrigin = "http://localhost:5173";
    mocks.siteConfig.publicWebOriginSource = "settings";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  it("box 形态在左栏提示本机地址，展开后才显示来源与配置入口", async () => {
    await act(async () => { root.render(<PublicOriginRiskControl variant="box" />); });
    await flushEffects();

    // 原型左栏提示框：只给结论，不铺开细节
    expect(host.textContent).toContain("分享地址仅本机可访问");
    expect(host.textContent).toContain("当前分享地址为 localhost，仅本机可访问。");
    expect(host.textContent).not.toContain("地址来源");

    await act(async () => {
      findButtonByText(host, "配置公开地址")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flushEffects();

    expect(host.textContent).toContain("地址来源");
    expect(host.textContent).toContain("管理员设置");
    expect(host.textContent).toContain("独立公开地址");
  });

  it("非 localhost 时提示改为待验证，不再报本机风险", async () => {
    mocks.siteConfig.publicWebOrigin = "https://note.example.com";

    await act(async () => { root.render(<PublicOriginRiskControl variant="badge" />); });
    await flushEffects();

    expect(host.textContent).toContain("公开地址待验证");
    expect(host.textContent).not.toContain("仅本机可访问");
  });
});
