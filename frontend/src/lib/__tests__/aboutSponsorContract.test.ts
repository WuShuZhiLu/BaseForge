import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

function locale(relativeUrl: string) {
  return JSON.parse(source(relativeUrl)) as Record<string, unknown>;
}

/**
 * 关于页清理契约（0.2）：打赏入口、空的「更新日志」按钮与其自动弹窗已移除，
 * 对应的 i18n 死键与赞赏码图片一并删除，避免下次有人照着键名把 UI 加回来。
 */
describe("settings about panel cleanup contract", () => {
  it("no longer renders sponsor UI", () => {
    const settings = source("../../components/SettingsModal.tsx");

    expect(settings).not.toContain("about.sponsor");
    expect(settings).not.toContain("@/assets/sponsor/");
    expect(settings).not.toContain("sponsorMethod");
    expect(settings).not.toContain("sponsorPreviewOpen");
  });

  it("no longer opens the empty changelog modal", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const app = source("../../App.tsx");

    expect(settings).not.toContain("WhatsNewModal");
    expect(settings).not.toContain("about.changelog");
    // 自动弹窗接线也必须断掉：changelog.json 已停止生成，弹出来恒为「暂无更新记录」
    expect(app).not.toContain("WhatsNewModal");
    expect(app).not.toContain("useWhatsNew");
  });

  it("drops the dead locale keys removed with the sponsor and changelog UI", () => {
    for (const file of ["../../i18n/locales/zh-CN.json", "../../i18n/locales/en.json"]) {
      const json = locale(file) as { about?: Record<string, unknown>; whatsNew?: unknown };
      const about = json.about ?? {};

      expect(json, `${file} 不应再有 whatsNew 段`).not.toHaveProperty("whatsNew");
      for (const key of [
        "sponsor",
        "sponsorDesc",
        "sponsorAction",
        "sponsorCollapse",
        "sponsorMethod",
        "sponsorWechat",
        "sponsorAlipay",
        "sponsorWechatTip",
        "sponsorAlipayTip",
        "changelog",
        "changelogDesc",
        "viewChangelog",
        "communityQrTitle",
        "communityQrDesc",
      ]) {
        expect(about, `${file} 的 about.${key} 是死键`).not.toHaveProperty(key);
      }
    }
  });

  it("keeps QQ group feedback and version info intact", () => {
    const settings = source("../../components/SettingsModal.tsx");

    expect(settings).toContain("about.feedbackQqGroup");
    expect(settings).toContain("VersionCompareCard");
    expect(settings).toContain("[BaseForge 反馈]");
  });

  it("does not advertise the removed knowledge Q&A in the feature list", () => {
    for (const file of ["../../i18n/locales/zh-CN.json", "../../i18n/locales/en.json"]) {
      const about = (locale(file) as { about: Record<string, string> }).about;
      expect(about.featureAI).not.toMatch(/知识问答|knowledge Q&A/i);
    }
  });
});
