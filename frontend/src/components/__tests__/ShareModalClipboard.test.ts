import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/ShareModal.tsx"), "utf8");

describe("ShareModal clipboard fallback", () => {
  it("uses the shared clipboard helper instead of the Edge-sensitive direct API", () => {
    expect(source).toContain('import { copyText } from "@/lib/clipboard";');
    expect(source).toContain("const ok = await copyText(value);");
    expect(source).toContain('t("shareUi.copyFailed")');
    expect(source).not.toContain("navigator.clipboard.writeText(value)");
  });

  it("only clears the copied indicator for the same share", () => {
    expect(source).toContain("setCopied((current) => current === id ? null : current)");
  });
});

describe("ShareModal 两档预设（原型 ②）", () => {
  it("只有「仅链接 / 链接 + 密码」两档，密码档带推荐徽标", () => {
    expect(source).toContain('t("shareUi.tierLinkTitle")');
    expect(source).toContain('t("shareUi.tierPasswordTitle")');
    expect(source).toContain('t("shareUi.tierRecommended")');
    // 不做「指定成员」：不应出现第三档预设
    expect(source).not.toContain("tierMember");
  });

  it("密码档默认 7 天、10 个会话；仅链接档清空密码并回到默认有效期", () => {
    expect(source).toContain("const applyTier = (tier: \"link\" | \"password\") => {");
    expect(source).toContain("setPassword((current) => current.trim() || randomSharePassword());");
    expect(source).toContain("setExpiryPreset(DEFAULT_EXPIRY_PRESET);");
    expect(source).toContain('setMaxViews("10");');
    expect(source).toContain("setPassword(\"\");");
    // 默认值来自共享常量，不能又写死一个 7
    expect(source).toContain("SHARE_DEFAULT_EXPIRY_DAYS");
  });

  it("随机密码去掉了易混淆字符，且不用 Math.random", () => {
    expect(source).toContain('const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";');
    expect(source).toContain("crypto.getRandomValues(new Uint8Array(8))");
    expect(source).not.toContain("Math.random()");
  });

  it("预设卡用 aria-pressed 表达选中，且不把 button 嵌进 label", () => {
    expect(source).toContain("aria-pressed={active}");
    expect(source).toContain("const active = tier.key === \"password\" ? password.trim().length > 0 : password.trim().length === 0;");
  });
});
