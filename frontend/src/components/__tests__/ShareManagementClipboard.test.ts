import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(resolve(process.cwd(), "src/components/ShareManagementPage.tsx"), "utf8");
// 公开分享地址的复制入口按原型挪到了左栏 riskbox（PublicOriginRiskControl），
// 主区只负责分享链接本身的复制。
const originSource = readFileSync(resolve(process.cwd(), "src/components/PublicOriginRiskControl.tsx"), "utf8");

describe("ShareManagementPage clipboard fallback", () => {
  it("uses the shared clipboard helper for share links and public origins", () => {
    expect(pageSource).toContain('import { copyText } from "@/lib/clipboard";');
    expect(originSource).toContain("const ok = await copyText(publicOrigin.origin);");
    expect(pageSource).toContain("const ok = await copyText(shareUrl(item));");
    expect(pageSource).not.toContain("navigator.clipboard.writeText");
    expect(originSource).not.toContain("navigator.clipboard.writeText");
  });

  it("keeps the manual-copy error when both clipboard strategies fail", () => {
    expect(pageSource).toContain('toast.error("复制失败，请手动复制")');
  });
});
