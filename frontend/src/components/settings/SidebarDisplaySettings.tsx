import { useMobileRailHidden } from "@/hooks/useMobileRailHidden";
import { useSidebarTextStyle } from "@/hooks/useSidebarTextStyle";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 外观设置新增两块（上游 1.5.1 行为，纯增量接入）：
 *   1. 侧栏文字风格：可读（默认，现状）/ 经典（整体小一号）；
 *   2. 移动端导航条开关：隐藏后可在侧栏顶部找回。
 * 做成自包含组件，避免往 SettingsModal 的面板函数里塞 hook。
 */
export default function SidebarDisplaySettings() {
  const { t } = useTranslation();
  const [sidebarTextStyle, setSidebarTextStyle] = useSidebarTextStyle();
  const [mobileRailHidden, setMobileRailHidden] = useMobileRailHidden();
  return (
    <>
      <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
        <div className="min-w-0">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("settings.sidebarTextStyle", { defaultValue: "侧栏文字风格" })}</span>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t("settings.sidebarTextStyleDesc", { defaultValue: "调整侧栏、目录树与笔记列表的字号" })}</p>
        </div>
        <div role="group" aria-label={t("settings.sidebarTextStyle", { defaultValue: "侧栏文字风格" })} className="flex shrink-0 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
          {(["readable", "classic"] as const).map((style) => (
            <button
              key={style}
              type="button"
              aria-pressed={sidebarTextStyle === style}
              onClick={() => setSidebarTextStyle(style)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                sidebarTextStyle === style
                  ? "bg-white text-accent-primary shadow-sm dark:bg-zinc-700"
                  : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200",
              )}
            >
              {t(style === "readable" ? "settings.sidebarTextReadable" : "settings.sidebarTextClassic", { defaultValue: style === "readable" ? "可读" : "经典" })}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
        <div className="min-w-0">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("settings.mobileRailHidden", { defaultValue: "隐藏移动端导航条" })}</span>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t("settings.mobileRailHiddenDesc", { defaultValue: "手机端隐藏底部导航条；隐藏后可在侧栏顶部找回" })}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={mobileRailHidden}
          aria-label={t("settings.mobileRailHidden", { defaultValue: "隐藏移动端导航条" })}
          onClick={() => setMobileRailHidden(!mobileRailHidden)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            mobileRailHidden ? "bg-accent-primary" : "bg-zinc-300 dark:bg-zinc-700",
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
              mobileRailHidden ? "translate-x-5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    </>
  );
}
