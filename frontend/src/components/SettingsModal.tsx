import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { motion, AnimatePresence } from "framer-motion";
import { Palette, Shield, Database, X, Settings, Camera, Save, Loader2, Trash2, Upload, Type, Check, ChevronDown, Globe, Bot, Users, Info, ExternalLink, RefreshCw, Key, Keyboard, Building2, BookOpen, ToggleLeft, Download, FolderSync, Mail, Mic, Workflow, CalendarClock, Search } from "lucide-react";
import { CODE_BLOCK_THEMES } from "@/lib/codeBlockTheme";
import { useTranslation } from "react-i18next";
import qqGroupQr from "@/assets/feedback/qq-group.jpg";
import ThemeToggle from "@/components/ThemeToggle";
import SkinSwitcher from "@/components/SkinSwitcher";
import SecuritySettings from "@/components/SecuritySettings";
import TokenManagement from "@/components/TokenManagement";
import DataManager from "@/components/DataManager";
import FolderSyncSettings from "@/components/settings/FolderSyncSettings";
import SyncSettingsTab from "@/components/settings/SyncSettingsTab";
import ShortcutSettingsPanel from "@/components/settings/ShortcutSettingsPanel";
import AISettingsPanel from "@/components/AISettingsPanel";
import SidebarDisplaySettings from "@/components/settings/SidebarDisplaySettings";
import SpeechSettingsPanel from "@/components/SpeechSettingsPanel";
import AutomationCenter from "@/components/automation/AutomationCenter";
import TaskDigestSettings from "@/components/automation/TaskDigestSettings";
import MobileAccountSettings from "@/components/settings/MobileAccountSettings";
import { isAndroidNativeRuntime, isMobileLocalMode } from "@/lib/mobileLocalMode";
import UserManagement from "@/components/UserManagement";
import WorkspaceManagement from "@/components/WorkspaceManagement";
import DownloadPanel from "@/components/DownloadPanel";
import { useSiteSettings, BUILTIN_FONTS, getBuiltinFontName } from "@/hooks/useSiteSettings";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { api } from "@/lib/api";
import { isDesktop, checkForUpdates, onUpdaterStatus, getReleaseChannel, isPortableDesktop, getAppInfo, setDesktopHideMenuBar as setDesktopHideMenuBarPreference, type UpdaterPayload } from "@/lib/desktopBridge";
import { CustomFont } from "@/types";
import { cn } from "@/lib/utils";
import { detectShortcutSurface } from "@/lib/shortcutRegistry";
import {
  loadMobileKnowledgeTreeCompact,
  loadMobileKnowledgeTreeViewMode,
  MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT,
  MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY,
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
  saveMobileKnowledgeTreeCompact,
  saveMobileKnowledgeTreeViewMode,
  type MobileKnowledgeTreeViewMode,
} from "@/lib/mobileKnowledgeTreeViewMode";

type TabId = "appearance" | "switches" | "shortcuts" | "ai" | "voice" | "automation" | "security" | "tokens" | "data" | "sync" | "folderSync" | "users" | "workspaces" | "download" | "about";

/** 设置导航的五个分组。分组只影响导航层展示，不改变任何面板的内容或归属。 */
type SettingsGroupId = "personal" | "connection" | "data" | "system" | "about";
const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; label: string }> = [
  { id: "personal", label: "个人" },
  { id: "connection", label: "连接" },
  { id: "data", label: "数据" },
  { id: "system", label: "系统管理" },
  { id: "about", label: "关于" },
];

/**
 * 设置内搜索的关键词索引：每一项都对应面板里真实存在的设置项或能力，
 * 只用于把搜索词定位到 tab，不新增、不隐藏任何设置。
 */
const SETTING_TAB_KEYWORDS: Record<TabId, string> = {
  appearance: "主题 明暗 字体 语言 阅读密度 侧栏文字 站点名称 图标 编辑器默认 代码块主题 笔记列表",
  switches: "功能开关 大纲 笔记标签页 自动锁定 菜单栏 网页端 目录树",
  shortcuts: "快捷键 键位 组合键 冲突 导入 导出",
  ai: "AI 模型 服务商 API Key 提示词包 文档整理 写作助手 MCP RAG 外部 AI 端点 知识库 启动命令",
  voice: "语音 转写 Whisper 识别",
  automation: "自动化 任务简报 Webhook 时区 定时",
  security: "密码 两步验证 2FA 恢复码 会话 头像 昵称 文件夹锁定",
  tokens: "令牌 token CLI 笔记本范围 授权",
  data: "导入 导出 备份 恢复 快照 WebDAV 数据库 危险区 全库 空间范围 数据文件",
  sync: "同步 冲突中心 服务器连接 多设备 工作区同步",
  folderSync: "文件夹同步 本地目录 桌面",
  users: "用户 成员 管理员 账号 权限",
  workspaces: "空间管理 工作区 空间 协作 成员",
  download: "下载 安装包 客户端 Docker 桌面 移动",
  about: "关于 版本 反馈 开源 更新",
};

interface SettingsModalProps {
  onClose: () => void;
  defaultTab?: TabId;
}

/**
 * Panel 级错误兜底：
 *
 * 背景：移动端（Capacitor / Android WebView）实测，部分 panel（尤其是 Data，
 * 由于其顶层 import 了 exportService / importService / 三个云盘组件，链路里包含
 * lowlight、tiptap、sessionStorage 等可能在受限 WebView 环境下抛错的依赖）
 * 在 mount 时同步抛错。由于全应用没有 ErrorBoundary，这种异常会冒泡到根，
 * 导致 createPortal 出去的整个 SettingsModal 子树被 React 卸载——表现为
 * "用户切到该 tab 后整个设置弹窗消失，回到笔记主界面"。
 *
 * 这里就地实现一个最小 ErrorBoundary，把"卸载整个 modal"的硬故障降级为
 * "该 panel 显示一句加载失败"的软故障，让其它 panel 仍然可用，并把错误
 * 留在 console 便于排查（不静默吞）。activeTab 变化时通过 key 重置状态，
 * 避免一次失败后切换到正常 panel 仍卡在错误态。
 */
class PanelErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 故意保留 console.error：移动端连 USB 调试时，这是唯一能拿到原始 stack 的途径。
    console.error("[SettingsModal] panel render failed:", error, info.componentStack);
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

/**
 * VersionCompareCard — "关于"页的版本对比卡
 *
 * 展示：
 *   - 当前客户端版本（编译期 __APP_VERSION__）
 *   - 服务端版本（/api/version, 由后端从根 package.json 解析）
 *   - GitHub 最新 release（后端 /api/releases/latest 代理，含 60s 缓存）
 *
 * 交互：
 *   - 桌面端（Electron）额外渲染"检查更新"按钮，走 electron-updater；
 *     同时订阅 updater 状态并在卡片下方滚动显示（checking / downloading %）。
 *   - Web / 移动端没有桥接，只显示三个版本 + 仓库链接。
 *
 * 错误策略：
 *   - 后端失败 → serverVersion 显示"unknown"并给"重试"按钮；
 *   - release 失败 → 展示 fallback 文案 + 仓库链接；
 *   - 都静默失败，不弹错误弹窗——"版本对比"本身是锦上添花，不要阻塞 About 渲染。
 */
function VersionCompareCard() {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [release, setRelease] = useState<
    | {
        available: true;
        tag: string;
        version: string;
        name: string;
        htmlUrl: string;
        publishedAt: string;
        prerelease: boolean;
        draft: boolean;
        body?: string;
      }
    | { available: false; reason: string }
    | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterPayload | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const desktop = isDesktop();
  const releaseChannel = getReleaseChannel();
  // Portable / 免安装版（Windows portable target）不走 electron-updater，
  // autoUpdater.checkForUpdates() 会抛 error；此时按钮要换成"前往下载页"，
  // 避免用户点了之后静默失败还以为是网络问题。
  const portable = isPortableDesktop();
  const clientVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

  // 拉版本信息
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setServerError(null);
    Promise.allSettled([api.getVersion(), api.getLatestRelease()])
      .then(([v, r]) => {
        if (cancelled) return;
        if (v.status === "fulfilled") {
          setServerVersion(v.value.appVersion || null);
        } else {
          setServerError(v.reason instanceof Error ? v.reason.message : String(v.reason));
        }
        if (r.status === "fulfilled") {
          setRelease(r.value);
        } else {
          setRelease({ available: false, reason: "request_failed" });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // 桌面端订阅 autoUpdater 状态
  useEffect(() => {
    if (!desktop) return;
    const off = onUpdaterStatus((p) => setUpdaterStatus(p));
    return off;
  }, [desktop]);

  const handleRetry = () => setReloadTick((t) => t + 1);
  const handleCheckUpdates = async () => {
    setUpdaterStatus({ status: "checking" });
    try {
      const res = await checkForUpdates();
      if (!res.ok && res.reason) {
        setUpdaterStatus({ status: "error", message: res.reason });
      }
    } catch (e) {
      setUpdaterStatus({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // 比较结果：outdated = 客户端 < 服务端
  const isOutdated =
    !!serverVersion && serverVersion !== "0.0.0" && serverVersion !== clientVersion;
  const hasNewerRelease =
    release?.available &&
    release.version !== clientVersion &&
    release.version !== serverVersion;

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">版本信息</h3>
        <button
          type="button"
          onClick={handleRetry}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400 hover:text-accent-primary disabled:opacity-50"
          title="重新拉取"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          {loading ? "检查中" : "重新检查"}
        </button>
      </div>

      <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-2 text-xs">
        {/* 客户端 */}
        <span className="text-zinc-500 dark:text-zinc-400">当前客户端</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100">v{clientVersion}</span>
        <span className="text-zinc-400 dark:text-zinc-600">
          {typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")
            ? "Desktop"
            : desktop
              ? "Desktop"
              : "Web"}
        </span>

        {/* 服务端 */}
        <span className="text-zinc-500 dark:text-zinc-400">服务端</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100">
          {serverError ? (
            <span className="text-amber-500">unknown</span>
          ) : serverVersion ? (
            <>v{serverVersion}</>
          ) : (
            <span className="text-zinc-400">—</span>
          )}
        </span>
        <span className="text-right">
          {isOutdated ? (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
              需刷新
            </span>
          ) : serverVersion ? (
            <span className="text-emerald-500">匹配</span>
          ) : null}
        </span>

        {/* GitHub 最新 release */}
        <span className="text-zinc-500 dark:text-zinc-400">最新发布</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100 truncate">
          {release?.available ? (
            <a
              href={release.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-primary hover:underline"
              title={release.name || release.tag}
            >
              v{release.version}
            </a>
          ) : release && !release.available ? (
            <span className="text-zinc-400">不可用</span>
          ) : (
            <span className="text-zinc-400">—</span>
          )}
        </span>
        <span className="text-right">
          {hasNewerRelease ? (
            <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400">
              可升级
            </span>
          ) : null}
        </span>
      </div>

      {/* 桌面端：检查更新按钮 + autoUpdater 状态
          Portable 版本不支持 electron-updater，切换成"前往下载页"CTA，
          并显式给出原因提示，避免用户点按钮后只看到模糊的错误。 */}
      {desktop && (
        <div className="pt-2 border-t border-zinc-200/60 dark:border-zinc-800/60 space-y-2">
          {releaseChannel && (
            <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
              <span>发布渠道</span>
              <span className="font-mono px-1.5 py-0.5 rounded bg-zinc-200/60 dark:bg-zinc-700/40 text-zinc-700 dark:text-zinc-200">
                {releaseChannel}
                {portable ? " · portable" : ""}
              </span>
            </div>
          )}
          {portable ? (
            <>
              {/* 下载地址只从后端返回的 release 里取，不写死仓库：
                  发布仓库可由部署方配置，写死会把用户导到无关的下载页。 */}
              {release?.available && release.htmlUrl ? (
                <a
                  href={release.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-primary text-white text-xs font-medium hover:opacity-90"
                >
                  <ExternalLink size={12} />
                  前往下载页
                </a>
              ) : (
                <span className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-200/70 dark:bg-zinc-700/40 text-zinc-500 dark:text-zinc-400 text-xs font-medium">
                  暂无下载地址
                </span>
              )}
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 text-center leading-relaxed">
                免安装版不支持自动更新，请下载新版本 portable.exe 替换当前文件。
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleCheckUpdates}
                disabled={updaterStatus?.status === "checking" || updaterStatus?.status === "downloading"}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-primary text-white text-xs font-medium hover:opacity-90 disabled:opacity-60"
              >
                <RefreshCw
                  size={12}
                  className={
                    updaterStatus?.status === "checking" || updaterStatus?.status === "downloading"
                      ? "animate-spin"
                      : ""
                  }
                />
                检查桌面端更新
              </button>
              {updaterStatus && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400 text-center">
                  {renderUpdaterStatus(updaterStatus)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function renderUpdaterStatus(p: UpdaterPayload): string {
  switch (p.status) {
    case "checking":
      return "正在检查更新…";
    case "not-available":
      return "已是最新版本";
    case "available":
      return `发现新版本 v${p.version ?? "?"}，准备下载`;
    case "downloading": {
      const pct = typeof p.percent === "number" ? ` ${p.percent.toFixed(1)}%` : "";
      return `正在下载${pct}`;
    }
    case "downloaded":
      return `新版本 v${p.version ?? "?"} 已下载，将在下次重启时安装`;
    case "error":
      return `更新失败：${p.message || "未知错误"}`;
    default:
      return "";
  }
}

/**
 * 简易图片放大 Lightbox
 * - 点击图片打开，Esc/点击蒙层/关闭按钮 关闭
 * - createPortal 到 body，避免被 SettingsModal 的 overflow/transform 截断
 * - 故意做轻：赞赏码场景只需要看清原图，不需要缩放/平移
 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="absolute top-3 right-3 p-2 rounded-lg bg-black/60 border border-white/10 text-white/90 hover:bg-white/10 transition-colors"
        title="关闭 (Esc)"
        aria-label="关闭"
        onClick={onClose}
      >
        <X size={16} />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg shadow-2xl bg-white"
        draggable={false}
      />
    </div>,
    document.body
  );
}

function AboutPanel() {
  const { t } = useTranslation();
  const feedbackEmail = "lingzhi_gong@foxmail.com";
  const feedbackMailto = `mailto:${feedbackEmail}?subject=${encodeURIComponent("[BaseForge 反馈]")}`;
  const feedbackQqGroupNumber = "1093473044";
  const [feedbackQqPreviewOpen, setFeedbackQqPreviewOpen] = useState(false);
  return (
    <div className="space-y-6">
      {/* 标题区 */}
      <div className="text-center py-4">
        <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{t('about.appName')}</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">{t('about.slogan')}</p>
        <span className="inline-block mt-2 px-3 py-0.5 rounded-full bg-accent-primary/10 text-accent-primary text-xs font-medium">
          {t('about.version')} {__APP_VERSION__}
        </span>
      </div>

      {/* 版本对比卡（客户端 / 服务端 / GitHub 最新 release） */}
      <VersionCompareCard />

      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      {/* 简介 */}
      <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
        {t('about.description')}
      </p>

      {/* 核心能力 */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">{t('about.features')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            'featureEditor', 'featureAI', 'featureClipper',
            'featureMindMap', 'featureSync', 'featureSelfHost',
          ].map((key) => (
            <div key={key} className="flex items-start gap-2 p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/40">
              <Check size={14} className="text-accent-primary mt-0.5 shrink-0" />
              <span className="text-xs text-zinc-700 dark:text-zinc-300">{t(`about.${key}`)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      {/* 开源信息 */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
        <div className="min-w-0">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('about.openSource')}</span>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('about.license')}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {t('about.basedOn')}{" "}
            <a
              href="https://github.com/cropflre/nowen-note"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-accent-primary underline underline-offset-2 decoration-accent-primary/40 hover:decoration-accent-primary"
            >
              nowen-note
              <ExternalLink size={10} />
            </a>
          </p>
        </div>
        <a
          href="https://github.com/cropflre/nowen-note"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium hover:opacity-80 transition-opacity shrink-0 ml-3"
        >
          <ExternalLink size={12} />
          {t('about.github')}
        </a>
      </div>

      {/* 意见与 Bug 反馈 */}
      <a
        href={feedbackMailto}
        className="w-full flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/50 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-sky-500/10 text-sky-500 shrink-0">
            <Mail size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t('about.feedback')}
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t('about.feedbackDesc')}
            </div>
          </div>
        </div>
        <div className="ml-4 text-right shrink-0">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {t('about.feedbackAction')}
          </div>
          <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">
            {feedbackEmail}
          </div>
        </div>
      </a>

      {/* QQ 群反馈 */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-sky-500/10 text-sky-500 shrink-0">
              <Users size={16} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t('about.feedbackQqGroup')}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {t('about.feedbackQqGroupDesc')}
              </div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-300 mt-1">
                {t('about.feedbackQqGroupNumber', { number: feedbackQqGroupNumber })}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFeedbackQqPreviewOpen(true)}
            className="shrink-0 rounded-lg overflow-hidden cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            title={t('about.feedbackQqGroup')}
            aria-label={t('about.feedbackQqGroup')}
          >
            <img
              src={qqGroupQr}
              alt={t('about.feedbackQqGroupNumber', { number: feedbackQqGroupNumber })}
              className="w-16 h-16 object-cover bg-white p-1"
              loading="lazy"
              draggable={false}
            />
          </button>
        </div>
      </div>

      {/* 底部 */}
      <p className="text-center text-xs text-zinc-400 dark:text-zinc-600">
        {t('about.madeWith')}
      </p>

      {feedbackQqPreviewOpen && (
        <ImageLightbox
          src={qqGroupQr}
          alt={t('about.feedbackQqGroupNumber', { number: feedbackQqGroupNumber })}
          onClose={() => setFeedbackQqPreviewOpen(false)}
        />
      )}
    </div>
  );
}

function SwitchesPanel() {
  const { t } = useTranslation();
  const { prefs: userPrefs, setPref: setUserPref } = useUserPreferences();
  const [isAdmin, setIsAdmin] = useState(false);
  const [webUiEnabled, setWebUiEnabled] = useState(false);
  const [desktopHideMenuBar, setDesktopHideMenuBar] = useState(true);
  const [desktopPlatform, setDesktopPlatform] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [mobileKnowledgeTreeMode, setMobileKnowledgeTreeMode] = useState<MobileKnowledgeTreeViewMode>(
    () => loadMobileKnowledgeTreeViewMode(),
  );
  const [mobileKnowledgeTreeCompact, setMobileKnowledgeTreeCompact] = useState(
    () => loadMobileKnowledgeTreeCompact(),
  );
  const desktop = isDesktop();
  const supportsDesktopMenuBarToggle = desktop && desktopPlatform !== "darwin";
  // 移动端专有开关只在实际走移动端外壳时才出现：Android 原生运行时，
  // 或视口窄到触发移动抽屉（<md，与 App.tsx 里 SidebarMobile 容器的 md:hidden 一致）。
  // 这样桌面端/Web 大窗口不会看到一半用不上的项。
  const [narrowViewport, setNarrowViewport] = useState(
    () => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(max-width: 767px)").matches,
  );
  const isMobileRuntime = isAndroidNativeRuntime() || narrowViewport;
  const markdownDefaultModes = [
    { value: "source" as const, label: t("markdown.view.source") },
    { value: "preview" as const, label: t("markdown.view.preview") },
    { value: "split" as const, label: t("markdown.view.split") },
  ];

  // 运行时跟随视口变化：桌面窗口缩到移动断点以下时移动端开关即时出现/消失。
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 767px)");
    const onChange = (event: MediaQueryListEvent) => setNarrowViewport(event.matches);
    setNarrowViewport(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => {
        if (cancelled) return;
        const admin = (u as any)?.role === "admin";
        setIsAdmin(admin);
        // 「关闭网页端页面」是站点级配置，只有管理员需要它，非管理员请求也拿不到可写权限。
        if (!admin) return;
        api.getSiteSettings()
          .then((s) => { if (!cancelled) setWebUiEnabled(s.web_ui_enabled !== "false"); })
          .catch(() => {});
      })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    if (desktop) {
      getAppInfo()
        .then((info) => {
          if (cancelled) return;
          setDesktopHideMenuBar(!!info?.hideMenuBar);
          setDesktopPlatform(info?.platform ?? null);
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [desktop]);

  useEffect(() => {
    const syncMode = () => setMobileKnowledgeTreeMode(loadMobileKnowledgeTreeViewMode());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY) syncMode();
    };
    window.addEventListener(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, syncMode);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, syncMode);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  useEffect(() => {
    const syncCompact = () => setMobileKnowledgeTreeCompact(loadMobileKnowledgeTreeCompact());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY) syncCompact();
    };
    window.addEventListener(MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT, syncCompact);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT, syncCompact);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  const handleToggleMobileKnowledgeTreeMode = (treeEnabled: boolean) => {
    const nextMode: MobileKnowledgeTreeViewMode = treeEnabled ? "tree" : "navigator";
    setMobileKnowledgeTreeMode(nextMode);
    saveMobileKnowledgeTreeViewMode(nextMode);
  };

  const handleToggleMobileKnowledgeTreeCompact = (nextCompact: boolean) => {
    setMobileKnowledgeTreeCompact(nextCompact);
    saveMobileKnowledgeTreeCompact(nextCompact);
  };

  const handleToggleWebUi = async (next: boolean) => {
    const prev = webUiEnabled;
    setWebUiEnabled(next);
    setSavingKey("webUi");
    try {
      const updated = await api.updateSiteSettings({ web_ui_enabled: next });
      setWebUiEnabled(updated.web_ui_enabled !== "false");
    } catch {
      setWebUiEnabled(prev);
    } finally {
      setSavingKey(null);
    }
  };

  const handleToggleDesktopMenuBar = async (hide: boolean) => {
    const prev = desktopHideMenuBar;
    setDesktopHideMenuBar(hide);
    setSavingKey("menuBar");
    try {
      const res = await setDesktopHideMenuBarPreference(hide);
      if (typeof res.hideMenuBar === "boolean") setDesktopHideMenuBar(res.hideMenuBar);
    } catch {
      setDesktopHideMenuBar(prev);
    } finally {
      setSavingKey(null);
    }
  };

  const switches = [
    {
      key: "noteTitleAsAppTitle" as const,
      label: t('settings.prefNoteTitleAsAppTitle'),
      hint: t('settings.prefNoteTitleAsAppTitleHint'),
    },
    {
      key: "outlineDefaultOpen" as const,
      label: t('settings.prefOutlineDefaultOpen'),
      hint: t('settings.prefOutlineDefaultOpenHint'),
    },
    {
      key: "lockOnOpen" as const,
      label: t('settings.prefLockOnOpen'),
      hint: t('settings.prefLockOnOpenHint'),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">
          {t('settings.switchesTitle')}
        </h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t('settings.switchesDesc')}
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 divide-y divide-zinc-200 dark:divide-zinc-800 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors max-sm:flex-col max-sm:items-stretch">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none">
              {t("settings.markdownDefaultViewMode")}
            </div>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
              {t("settings.markdownDefaultViewModeDesc")}
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex-shrink-0 max-sm:w-full">
            {markdownDefaultModes.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => setUserPref("markdownDefaultViewMode", mode.value)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap max-sm:flex-1",
                  userPrefs.markdownDefaultViewMode === mode.value
                    ? "bg-white dark:bg-zinc-700 text-accent-primary shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        {switches.map((item) => (
          <label key={item.key} className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors">
            <input
              type="checkbox"
              checked={userPrefs[item.key]}
              onChange={(e) => setUserPref(item.key, e.target.checked)}
              className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 cursor-pointer"
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none">
                {item.label}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
                {item.hint}
              </p>
            </div>
          </label>
        ))}

        {/* 移动端专有项：只在移动端外壳（Android 原生 / 窄视口抽屉）里出现，
            桌面端与 Web 大窗口不再列这些用不上的开关。 */}
        {isMobileRuntime && (
          <>
            <label
              data-settings-switch="mobile-knowledge-tree"
              className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors"
            >
              <input
                type="checkbox"
                checked={mobileKnowledgeTreeMode === "tree"}
                onChange={(event) => handleToggleMobileKnowledgeTreeMode(event.target.checked)}
                className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none">
                  {t("settings.mobileKnowledgeTreeMode")}
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
                  {t("settings.mobileKnowledgeTreeModeDesc")}
                </p>
              </div>
            </label>

            <label
              data-settings-switch="mobile-knowledge-tree-compact"
              className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors"
            >
              <input
                type="checkbox"
                checked={mobileKnowledgeTreeCompact}
                onChange={(event) => handleToggleMobileKnowledgeTreeCompact(event.target.checked)}
                className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none">
                  {t("settings.mobileKnowledgeTreeCompact")}
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
                  {t("settings.mobileKnowledgeTreeCompactDesc")}
                </p>
              </div>
            </label>
          </>
        )}

        {supportsDesktopMenuBarToggle && (
          <label className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors">
            <input
              type="checkbox"
              checked={desktopHideMenuBar}
              disabled={savingKey === "menuBar"}
              onChange={(e) => handleToggleDesktopMenuBar(e.target.checked)}
              className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 cursor-pointer disabled:opacity-50"
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none flex items-center gap-1.5">
                隐藏桌面端菜单栏
                {savingKey === "menuBar" && <Loader2 size={12} className="animate-spin text-zinc-400" />}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
                仅 Windows/Linux 生效；隐藏后可按 Alt 临时显示菜单栏，快捷键仍然可用。
              </p>
            </div>
          </label>
        )}

        {/* 站点级配置：仅管理员可见。普通用户看到会误以为是自己的账号设置。 */}
        {isAdmin && (
          <label
            data-settings-switch="web-ui-enabled"
            className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors"
          >
            <input
              type="checkbox"
              checked={!webUiEnabled}
              disabled={savingKey === "webUi"}
              onChange={(e) => handleToggleWebUi(!e.target.checked)}
              className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 cursor-pointer disabled:opacity-50"
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none flex items-center gap-1.5">
                关闭网页端页面
                {savingKey === "webUi" && <Loader2 size={12} className="animate-spin text-zinc-400" />}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
                开启后服务器只保留 API；浏览器访问网页端会显示禁用提示。桌面客户端使用本地界面连接 API，不受影响。
              </p>
            </div>
          </label>
        )}
      </div>
    </div>
  );
}

function AppearancePanel() {
  const { t, i18n } = useTranslation();
  const { siteConfig, updateSiteConfig, updateEditorFont } = useSiteSettings();
  const { prefs: userPrefs, setPref: setUserPref } = useUserPreferences();
  const [title, setTitle] = useState(siteConfig.title);
  const [previewIcon, setPreviewIcon] = useState(siteConfig.favicon);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 站点标识属于全站共享配置，只有系统管理员能改。
  // 这里独立拉一次身份（不依赖父组件传 props），与 DataManager 的做法保持一致，
  // 避免修改 SettingsModal 主体的渲染契约。
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => { if (!cancelled) setIsAdmin((u as any)?.role === "admin"); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, []);

  // 字体状态
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [isSwitchingFont, setIsSwitchingFont] = useState(false);
  const fontFileRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 加载自定义字体列表
  const loadFonts = useCallback(async () => {
    try {
      const fonts = await api.getFonts();
      setCustomFonts(fonts);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadFonts(); }, [loadFonts]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setFontDropdownOpen(false);
      }
    };
    if (fontDropdownOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fontDropdownOpen]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setSaveMessage(t('settings.iconTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewIcon(reader.result as string);
      setSaveMessage("");
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveIcon = () => {
    setPreviewIcon("");
    setSaveMessage("");
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setIsSaving(true);
    setSaveMessage("");
    try {
      await updateSiteConfig(title.trim(), previewIcon);
      setSaveMessage(t('settings.saveSuccess'));
      setTimeout(() => setSaveMessage(""), 2000);
    } catch {
      setSaveMessage(t('settings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = title !== siteConfig.title || previewIcon !== siteConfig.favicon;

  // 当前字体的显示名
  const currentFontName = (() => {
    const builtin = BUILTIN_FONTS.find(f => f.id === siteConfig.editorFontFamily);
    if (builtin) return getBuiltinFontName(builtin);
    const custom = customFonts.find(f => f.id === siteConfig.editorFontFamily);
    return custom ? custom.name : t('settings.interDefault');
  })();

  const handleSelectFont = async (fontId: string) => {
    setIsSwitchingFont(true);
    setFontDropdownOpen(false);
    try {
      await updateEditorFont(fontId);
    } catch { /* ignore */ }
    setIsSwitchingFont(false);
  };

  const handleUploadFonts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setUploadMessage("");
    setUploadSuccess(false);
    try {
      const result = await api.uploadFonts(files);
      const msgs: string[] = [];
      if (result.uploaded.length > 0) msgs.push(t('settings.fontUploadSuccess', { count: result.uploaded.length }));
      if (result.errors.length > 0) msgs.push(result.errors.join("; "));
      setUploadMessage(msgs.join(" · "));
      setUploadSuccess(result.uploaded.length > 0);
      await loadFonts();
      setTimeout(() => { setUploadMessage(""); setUploadSuccess(false); }, 4000);
    } catch (err: any) {
      setUploadMessage(err.message || t('settings.fontUploadFailed'));
      setUploadSuccess(false);
    } finally {
      setIsUploading(false);
      if (fontFileRef.current) fontFileRef.current.value = "";
    }
  };

  const handleDeleteFont = async (fontId: string) => {
    try {
      await api.deleteFont(fontId);
      // 如果删的是当前字体，回退默认
      if (siteConfig.editorFontFamily === fontId) {
        await updateEditorFont("");
      }
      await loadFonts();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-6">
      {/* 站点标识 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t('settings.siteIdentity')}</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-2">{t('settings.siteIdentityDesc')}</p>
        {!isAdmin && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-4">
            {t('settings.siteIdentityAdminOnly')}
          </p>
        )}
        {isAdmin && <div className="mb-6" />}

        <div className="flex flex-col sm:flex-row gap-6 items-start">
          {/* Logo 上传区域 */}
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('settings.siteIcon')}</span>
            <div
              className={cn(
                "relative w-20 h-20 rounded-2xl border-2 border-dashed border-zinc-300 dark:border-zinc-700 flex items-center justify-center overflow-hidden group transition-colors",
                isAdmin
                  ? "cursor-pointer hover:border-accent-primary"
                  : "cursor-not-allowed opacity-60"
              )}
              onClick={() => { if (isAdmin) fileInputRef.current?.click(); }}
            >
              {previewIcon ? (
                <img src={previewIcon} alt="Site Icon" className="w-full h-full object-cover" />
              ) : (
                <div className="flex flex-col items-center gap-1 text-zinc-400 dark:text-zinc-600">
                  <Camera size={20} />
                  <span className="text-[10px]">{t('settings.upload')}</span>
                </div>
              )}
              {isAdmin && (
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                  <Camera className="w-5 h-5 text-white" />
                </div>
              )}
            </div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageChange}
              accept="image/png,image/jpeg,image/svg+xml,image/x-icon,image/webp"
              className="hidden"
              disabled={!isAdmin}
            />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500">PNG/SVG/ICO · &lt;1MB</span>
              {previewIcon && isAdmin && (
                <button
                  onClick={handleRemoveIcon}
                  className="text-[10px] text-red-500 hover:text-red-400 transition-colors"
                >
                  {t('settings.remove')}
                </button>
              )}
            </div>
          </div>

          {/* 站点名称 */}
          <div className="flex-1 space-y-3 w-full">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('settings.siteName')}</label>
              <input
                type="text"
                value={title}
                onChange={(e) => { setTitle(e.target.value); setSaveMessage(""); }}
                maxLength={20}
                disabled={!isAdmin}
                className="w-full px-3 py-2 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all placeholder:text-zinc-400 disabled:opacity-60 disabled:cursor-not-allowed"
                placeholder={t('settings.siteNamePlaceholder')}
              />
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right">{title.length} / 20</p>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={isSaving || !title.trim() || !hasChanges}
                  className="flex items-center justify-center gap-1.5 px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-white rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {t('settings.saveChanges')}
                </button>
                {saveMessage && (
                  <span className={`text-xs ${saveMessage === t('settings.saveSuccess') ? "text-emerald-500" : "text-red-500"}`}>
                    {saveMessage}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 分割线 */}
      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      {/* 外观与主题 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t('settings.appearanceTheme')}</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">{t('settings.appearanceThemeDesc')}</p>
      </div>

      <div className="space-y-4">
        {/* 外观风格（Skin）：默认 / macOS —— 与下方明暗模式正交 */}
        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 space-y-3">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t('appearance.skinTitle', { defaultValue: '外观风格' })}
            </span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t('appearance.skinDesc', { defaultValue: '选择整体视觉语言。macOS 风格在 Apple 设备上体验最佳。' })}
            </p>
          </div>
          <SkinSwitcher />
        </div>

        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('settings.themeMode')}</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings.themeModeDesc')}</p>
          </div>
          <ThemeToggle />
        </div>


<SidebarDisplaySettings />
        {/* 编辑器字体 - 可交互 */}
        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('settings.editorFont')}</span>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings.editorFontDesc')}</p>
            </div>
            {isSwitchingFont && <Loader2 size={14} className="animate-spin text-accent-primary" />}
          </div>

          {/* 字体选择器下拉 */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setFontDropdownOpen(!fontDropdownOpen)}
              className="w-full flex items-center justify-between px-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100 hover:border-accent-primary/50 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Type size={14} className="text-zinc-400" />
                {currentFontName}
              </span>
              <ChevronDown size={14} className={cn("text-zinc-400 transition-transform", fontDropdownOpen && "rotate-180")} />
            </button>

            <AnimatePresence>
              {fontDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute z-50 top-full left-0 mt-1 w-full max-h-64 overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl"
                >
                  {/* 内置字体 */}
                  <div className="px-2 pt-2 pb-1">
                    <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2">{t('settings.builtinFonts')}</span>
                  </div>
                  {BUILTIN_FONTS.map(font => (
                    <button
                      key={font.id}
                      onClick={() => handleSelectFont(font.id)}
                      className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                    >
                      <span style={{ fontFamily: font.family }}>{getBuiltinFontName(font)}</span>
                      {siteConfig.editorFontFamily === font.id && <Check size={14} className="text-accent-primary" />}
                    </button>
                  ))}

                  {/* 自定义字体 */}
                  {customFonts.length > 0 && (
                    <>
                      <div className="h-px bg-zinc-100 dark:bg-zinc-800 mx-2 my-1" />
                      <div className="px-2 pt-1 pb-1">
                        <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2">{t('settings.importedFonts')}</span>
                      </div>
                      {customFonts.map(font => (
                        <div
                          key={font.id}
                          className="flex items-center justify-between px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors group"
                        >
                          <button
                            onClick={() => handleSelectFont(font.id)}
                            className="flex-1 text-left text-sm text-zinc-700 dark:text-zinc-300"
                          >
                            {font.name}
                            <span className="ml-2 text-[10px] text-zinc-400">.{font.format}</span>
                          </button>
                          <div className="flex items-center gap-1.5">
                            {siteConfig.editorFontFamily === font.id && <Check size={14} className="text-accent-primary" />}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDeleteFont(font.id); }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-400 hover:text-red-500 transition-all"
                              title={t('settings.deleteFont')}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 字体导入 */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => fontFileRef.current?.click()}
              disabled={isUploading}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg text-xs text-zinc-600 dark:text-zinc-400 hover:border-accent-primary/50 hover:text-accent-primary transition-colors disabled:opacity-50"
            >
              {isUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {t('settings.importFont')}
            </button>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t('settings.importFontHint')}</span>
            <input
              type="file"
              ref={fontFileRef}
              onChange={handleUploadFonts}
              accept=".otf,.otc,.ttc,.ttf,.woff,.woff2"
              multiple
              className="hidden"
            />
          </div>

          {uploadMessage && (
            <p className={cn("text-xs", uploadSuccess ? "text-emerald-500" : "text-amber-500")}>{uploadMessage}</p>
          )}

          {/* 字体预览 */}
          <div
            className="px-3 py-3 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-950"
            style={{ fontFamily: "var(--editor-font-family)" }}
          >
            <p className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">
              {t('settings.fontPreviewEn')}
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed mt-1">
              {t('settings.fontPreviewZh')}
            </p>
          </div>
        </div>

        {/* 语言切换 */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-zinc-500 dark:text-zinc-400" />
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('language.label')}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">
            {([
              { code: "zh-CN", label: t('language.zh') },
              { code: "en", label: t('language.en') },
            ] as const).map(lang => (
              <button
                key={lang.code}
                onClick={() => i18n.changeLanguage(lang.code)}
                className={cn(
                  "relative px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  i18n.language === lang.code
                    ? "bg-white dark:bg-zinc-700 text-accent-primary shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>

        {/* 阅读密度：影响编辑器正文段落与列表项的纵向间距/行高（per-device 偏好） */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div className="min-w-0 pr-3">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t('settings.readingDensity', { defaultValue: '阅读密度' })}
            </span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t('settings.readingDensityDesc', { defaultValue: '调节正文段落和列表项的纵向间距，紧凑模式更省空间。' })}
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex-shrink-0">
            {([
              { code: "cozy" as const, label: t('settings.densityCozy', { defaultValue: '宽松' }) },
              { code: "compact" as const, label: t('settings.densityCompact', { defaultValue: '紧凑' }) },
            ]).map(opt => (
              <button
                key={opt.code}
                onClick={() => setUserPref("readingDensity", opt.code)}
                className={cn(
                  "relative px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  userPrefs.readingDensity === opt.code
                    ? "bg-white dark:bg-zinc-700 text-accent-primary shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 编辑器默认值：这些偏好此前只能在编辑器工具条里改，设置页没有入口。
            这里只补入口，不改动 useUserPreferences 的读写语义，也不移除既有工具条。 */}
        <div className="space-y-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">编辑器默认值</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              新建笔记时使用的编辑器、代码块配色与笔记列表密度。
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-zinc-600 dark:text-zinc-400">默认编辑器</span>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">
              {([
                { code: "tiptap" as const, label: "富文本" },
                { code: "md" as const, label: "Markdown" },
              ]).map(opt => (
                <button
                  key={opt.code}
                  onClick={() => setUserPref("defaultEditorMode", opt.code)}
                  className={cn(
                    "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                    userPrefs.defaultEditorMode === opt.code
                      ? "bg-white dark:bg-zinc-700 text-accent-primary shadow-sm"
                      : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-zinc-600 dark:text-zinc-400">代码块主题</span>
            <select
              value={userPrefs.codeBlockTheme}
              onChange={(e) => setUserPref("codeBlockTheme", e.target.value as typeof userPrefs.codeBlockTheme)}
              className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-700 dark:text-zinc-300"
            >
              {CODE_BLOCK_THEMES.map(theme => (
                <option key={theme.id} value={theme.id}>{theme.label}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-xs text-zinc-600 dark:text-zinc-400">笔记列表仅显示标题</span>
            <input
              type="checkbox"
              checked={userPrefs.noteListTitleOnly}
              onChange={(e) => setUserPref("noteListTitleOnly", e.target.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
          </label>
        </div>

        {/*
         * 个人空间导入/导出的功能开关已下沉为 per-user 字段
         * （users.personalExportEnabled / personalImportEnabled，schema v6 起）。
         * 现在管理员需要在「用户管理」tab 里逐个用户编辑，不再是站点级全局开关。
         * 这里历史上的 FeatureTogglesSection 已整体移除。
         */}
      </div>
    </div>
  );
}

const SettingsModal = React.forwardRef<HTMLDivElement, SettingsModalProps>(
  function SettingsModal({ onClose, defaultTab = "appearance" }, ref) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const [settingsQuery, setSettingsQuery] = useState("");
  const { siteConfig } = useSiteSettings();
  const shortcutSurface = detectShortcutSurface();
  const [currentUser, setCurrentUser] = useState<{ id: string; role?: string; displayName?: string; username?: string } | null>(null);

  const fetchCurrentUser = useCallback(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => { if (!cancelled) setCurrentUser({ id: u.id, role: (u as any).role, displayName: (u as any).displayName, username: (u as any).username }); })
      .catch(() => { if (!cancelled) setCurrentUser(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => fetchCurrentUser(), [fetchCurrentUser]);

  // 监听 token 变化，重新拉取当前用户（防止切换账号后残留旧用户信息）
  useEffect(() => {
    const onTokenChanged = () => { fetchCurrentUser(); };
    window.addEventListener("nowen:token-changed", onTokenChanged);
    return () => window.removeEventListener("nowen:token-changed", onTokenChanged);
  }, [fetchCurrentUser]);

  // 监听"DataManager 完成导入后请求关闭弹窗"事件——用户在 DataManager 里
  // 把笔记导入到 ≠ 当前侧边栏的工作区，点击"切换到该工作区查看"按钮后，需要
  // 把这层 Modal 也关掉，否则切到目标工作区但弹窗仍盖住主界面，体感很奇怪。
  useEffect(() => {
    const onCloseRequest = () => onClose();
    window.addEventListener("nowen:close-settings", onCloseRequest);
    return () => window.removeEventListener("nowen:close-settings", onCloseRequest);
  }, [onClose]);

  const isAdmin = currentUser?.role === "admin";

  // 每个 tab 的 group 只用于导航层分组展示；面板内容、可见性条件与渲染分支都不变。
  // 白名单（appRoute.ts 的 SETTINGS_TAB_KEYS）必须与这里的 id 集合保持一致。
  // 「同步」只在客户端（桌面 / 移动原生）成立：它同步的是客户端本地副本与服务器。
  // 浏览器直连服务器时数据本来就在服务器上，SyncSettingsTab 在该运行时只会渲染一句
  // 「无需另外开启同步」的说明——对只发 Docker 镜像的部署就是纯噪音。
  // 判定口径与 SyncSettingsTab 内部一致：桌面桥存在，或 Capacitor 原生平台。
  const syncSurfaceAvailable = isDesktop() || Capacitor.isNativePlatform();

  const SETTING_TABS = useMemo(() => [
    // 个人
    { id: "appearance" as const, group: "personal" as const, label: t('settings.appearance'), icon: Palette },
    { id: "switches" as const, group: "personal" as const, label: t('settings.switches'), icon: ToggleLeft },
    ...(shortcutSurface !== "android" ? [{ id: "shortcuts" as const, group: "personal" as const, label: "快捷键", icon: Keyboard }] : []),
    { id: "ai" as const, group: "personal" as const, label: t('settings.aiAndMcp', { defaultValue: 'AI 与 MCP' }), icon: Bot },
    { id: "voice" as const, group: "personal" as const, label: t('speech.title', { defaultValue: '语音转写' }), icon: Mic },
    { id: "automation" as const, group: "personal" as const, label: t('automation.title', { defaultValue: '自动化' }), icon: Workflow },
    { id: "security" as const, group: "personal" as const, label: t('settings.security'), icon: Shield },
    // 连接：令牌供 MCP / CLI 使用；MCP 的服务端点与可用工具在 AI 面板里
    { id: "tokens" as const, group: "connection" as const, label: t('settings.tokens', { defaultValue: '访问令牌' }), icon: Key },
    // 数据：DataManager 内部按 scope 分流（空间 = 所有人；系统 = 仅管理员）
    { id: "data" as const, group: "data" as const, label: t('settings.dataAndBackup'), icon: Database },
    ...(syncSurfaceAvailable ? [{ id: "sync" as const, group: "data" as const, label: "同步", icon: RefreshCw }] : []),
    ...((window as any).nowenDesktop?.isDesktop ? [{ id: "folderSync" as const, group: "data" as const, label: t('folderSync.title'), icon: FolderSync }] : []),
    // 系统管理：仅管理员可见
    ...(isAdmin ? [{ id: "users" as const, group: "system" as const, label: t('settings.users'), icon: Users }] : []),
    ...(isAdmin ? [{ id: "workspaces" as const, group: "system" as const, label: t('settings.workspaces'), icon: Building2 }] : []),
    // 关于：下载客户端保留入口（内容按 VITE_CLIENT_DOWNLOADS_ENABLED 屏蔽）
    { id: "download" as const, group: "about" as const, label: t('settings.download', { defaultValue: '下载客户端' }), icon: Download },
    { id: "about" as const, group: "about" as const, label: t('about.title'), icon: Info },
  ], [t, shortcutSurface, isAdmin, syncSurfaceAvailable]);

  // 设置内搜索：匹配 tab 标签或关键词索引，点击结果直接切到对应面板。
  const visibleTabs = useMemo(() => {
    const q = settingsQuery.trim().toLowerCase();
    if (!q) return SETTING_TABS;
    return SETTING_TABS.filter((tab) =>
      `${tab.label} ${SETTING_TAB_KEYWORDS[tab.id]}`.toLowerCase().includes(q)
    );
  }, [settingsQuery, SETTING_TABS]);

  // 用 Portal 挂载到 body：
  //   SettingsModal 调用点位于 SidebarMobile 组件内部（见 SidebarMobile.tsx 的 AnimatePresence）。
  //   SidebarMobile 根容器使用 `.vibrancy-sidebar`，在 macOS 皮肤下会经由 ::before 应用
  //   backdrop-filter；CSS 规范规定任何非 none 的 backdrop-filter 都会让宿主成为
  //   内部 position: fixed 的 containing block。即使我们已经把 filter 挪到伪元素
  //   减小了冲撞面，SidebarMobile 子树未来可能加入 transform / filter / contain 等属性，
  //   都会再次困住本模态框。用 Portal 一次性脱离 SidebarMobile 子树，彻底杜绝此类布局事故。
  //
  // 移动端关闭误触防御（重要）：
  //   实测在 Capacitor / Android & iOS WebView 里，用户在弹窗内"长按 / 滚动 / 横向触摸"
  //   都会让弹窗瞬间消失。真因不是弹窗自身处理了点击，而是 App.tsx 的 useSwipeGesture
  //   在 document 上监听全局 touchstart/touchend：打开 SettingsModal 时 mobileSidebarOpen
  //   仍为 true，任何足够大的 deltaX 都会触发 setMobileSidebar(false)。SettingsModal 虽
  //   然 portal 到 body，但生命周期挂在 SidebarMobile 子树——SidebarMobile 卸载就把弹窗一起带走。
  //   React 合成事件的 stopPropagation 拦不住 document 原生监听，必须用 data 属性让全局
  //   hook 主动跳过本子树（见 App.tsx 同名实现）。
  //
  //   除此之外仍保留下列分层防御：
  //     - 桌面端遮罩点击关闭；移动端遮罩 max-md:hidden（视觉上看不见的遮罩没意义）；
  //     - 模态主体 touch-action: pan-y pinch-zoom，避免被 WebView 当作系统返回手势；
  //     - 顶层 motion.div 不绑 click，避免漏到外层的点击被解释成关闭。
  return createPortal(
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-0 md:p-4 md:sm:p-6"
      // data-swipe-blocker：让 App.tsx::useSwipeGesture 在本子树内的 touchstart 上主动跳过
      // 判定。整个 portal 子树（含移动端 tab 栏 / panel 内容）一并受保护。
      data-swipe-blocker="settings-modal"
    >
      {/* 背景遮罩：仅桌面端渲染。移动端模态主体已全屏覆盖，遮罩不可见且只会
          带来\"轻触即关闭\"的误触，故直接不挂载。 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="hidden md:block absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
      />

      {/* 模态框主体
          - touch-action: pan-y pinch-zoom：声明本容器内部只允许竖向滚动 + 双指缩放，
            禁止 WebView 把横向 / 边缘手势解释为系统级返回 / 抽屉手势；
          - onPointerDownCapture stopPropagation：把指针事件在捕获阶段就拦下，
            杜绝事件\"绕过\"主体冒到外层 motion.div 上。 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", duration: 0.5, bounce: 0 }}
        className="relative w-[min(1100px,86vw)] h-[min(78vh,calc(100dvh-4rem))] flex flex-col md:flex-row overflow-hidden bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 max-md:h-[100dvh] max-md:w-full max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0"
        style={{ touchAction: "pan-y pinch-zoom" }}
        onClick={(e) => e.stopPropagation()}
        onPointerDownCapture={(e) => e.stopPropagation()}
      >
        {/* 移动端：顶部标签栏 + 关闭按钮
            - sticky top-0：避免内容滚动时 tab 栏跟着上移露出后面的遮罩；
            - touch-action: pan-x：仅允许横向滑动（tab 多时可滑），杜绝竖向手势
              漂移到外层被识别为关闭/系统手势。 */}
        <div
          className="md:hidden sticky top-0 z-10 flex items-center border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/95 backdrop-blur"
          style={{ paddingTop: 'var(--safe-area-top)', touchAction: 'pan-x' }}
        >
          <div className="flex-1 flex items-center gap-1 px-3 py-2 overflow-x-auto no-scrollbar" style={{ touchAction: 'pan-x' }}>
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                    isActive
                      ? "bg-zinc-200/70 dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400"
                      : "text-zinc-500 dark:text-zinc-400 active:bg-zinc-200/40 dark:active:bg-zinc-800/50"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <button
            onClick={onClose}
            className="p-2 mr-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-lg transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 桌面端：左侧导航栏（搜索 + 五组分组，只改导航层，不动任何面板） */}
        <div className="hidden md:flex w-56 flex-shrink-0 bg-zinc-50 dark:bg-zinc-900/50 border-r border-zinc-200 dark:border-zinc-800 p-4 flex-col">
          <div className="flex items-center gap-2 mb-4 px-2">
            <Settings className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
            <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">{t('settings.title')}</span>
          </div>

          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
            <input
              type="search"
              value={settingsQuery}
              onChange={(e) => setSettingsQuery(e.target.value)}
              placeholder="搜索设置"
              aria-label="搜索设置"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-8 pr-2 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 outline-none focus:border-indigo-400 dark:focus:border-indigo-500"
            />
          </div>

          <nav className="flex-1 min-h-0 overflow-y-auto pr-1">
            {visibleTabs.length === 0 && (
              <p className="px-3 py-4 text-xs text-zinc-400 dark:text-zinc-600">没有匹配的设置项</p>
            )}
            {SETTINGS_GROUPS.map((group) => {
              const tabs = visibleTabs.filter((tab) => tab.group === group.id);
              if (tabs.length === 0) return null;
              return (
                <div key={group.id} className="mb-3">
                  <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {tabs.map((tab) => {
                      const Icon = tab.icon;
                      const isActive = activeTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                            isActive
                              ? "bg-zinc-200/70 dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400"
                              : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
                          }`}
                        >
                          <Icon className="w-4 h-4" />
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>

          {/* 底部版本信息：版本号由 vite.config.ts 从根 package.json 注入 */}
          <div className="mt-auto pt-4 border-t border-zinc-200 dark:border-zinc-800 px-2">
            <p className="text-xs text-zinc-400 dark:text-zinc-600">{siteConfig.title} v{__APP_VERSION__}</p>
          </div>
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto relative">
          {/* 关闭按钮 — 桌面端 */}
          <button
            onClick={onClose}
            className="hidden md:block sticky top-4 ml-auto mr-4 -mb-7 w-fit p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors z-20"
          >
            <X className="w-4 h-4" />
          </button>

          {/* 动态渲染内容 */}
          <div className="p-4 md:p-8 md:pr-14">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.15 }}
              >
                {/*
                  PanelErrorBoundary 用 activeTab 做 key：每次切 tab 都重新创建一个
                  Boundary 实例，已经"中过招"的 panel 不会污染下一个 panel 的状态；
                  同时把"模态框被整个卸掉退回笔记页"的灾难性体验降级成局部错误提示。
                */}
                <PanelErrorBoundary
                  key={activeTab}
                  fallback={
                    <div className="py-12 px-4 text-center">
                      <p className="text-sm text-zinc-600 dark:text-zinc-300">
                        {t('settings.panelLoadFailed')}
                      </p>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">
                        {t('settings.panelLoadFailedHint')}
                      </p>
                    </div>
                  }
                >
            {activeTab === "appearance" && <AppearancePanel />}
            {activeTab === "switches" && <SwitchesPanel />}
            {activeTab === "shortcuts" && shortcutSurface !== "android" && <ShortcutSettingsPanel />}
            {activeTab === "ai" && <AISettingsPanel />}
            {activeTab === "voice" && <SpeechSettingsPanel />}
            {activeTab === "automation" && (
              <div className="space-y-6">
                <TaskDigestSettings />
                <AutomationCenter />
              </div>
            )}
            {activeTab === "security" && <div className="space-y-6">
              {isAndroidNativeRuntime() && <MobileAccountSettings accountLabel={currentUser?.displayName || currentUser?.username} />}
              {!isMobileLocalMode() && <SecuritySettings />}
            </div>}
            {activeTab === "tokens" && <TokenManagement />}
                  {activeTab === "users" && isAdmin && <UserManagement currentUserId={currentUser?.id ?? null} />}
                  {activeTab === "workspaces" && isAdmin && <WorkspaceManagement />}
                  {/* data tab 对所有用户可见：DataManager 内部按 scope 分流
                       —— 「空间」所有人可用；「系统」仅管理员。 */}
                  {activeTab === "data" && <DataManager />}
                  {activeTab === "sync" && <SyncSettingsTab />}
                  {activeTab === "folderSync" && <FolderSyncSettings />}
                  {activeTab === "download" && <DownloadPanel />}
                  {activeTab === "about" && <AboutPanel />}
                </PanelErrorBoundary>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
});

export default SettingsModal;
