import "./lib/runtimePrelude";
import "./lib/runtimeCompatibility";
import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/androidCompat";
import "./lib/noteTransferRefreshBridge";
import "./lib/workspaceRefreshBridge";
import "./i18n";

// dev 诊断：未捕获错误上报到后端（仅开发模式），用于远程定位页面空白类问题
if (import.meta.env.DEV) {
  const reportClientError = (source: string, message: string, stack?: string) => {
    fetch("/api/pm/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, message: (message || "unknown").slice(0, 500), stack: (stack || "").slice(0, 3000) }),
    }).catch(() => {});
  };
  window.addEventListener("error", (e) => reportClientError("window.error", e.message ?? "unknown", e.error?.stack));
  window.addEventListener("unhandledrejection", (e) => reportClientError("unhandledrejection", String((e.reason as any)?.message ?? e.reason ?? "unknown"), (e.reason as any)?.stack));
}
// Must run before App and its import/export/editor schemas are evaluated.
import "./lib/imageNodeTransformBootstrap";
import { ThemeProvider } from "./components/ThemeProvider";
import { SiteSettingsProvider } from "./hooks/useSiteSettings";
import { ConfirmProvider } from "./components/ui/confirm";
import AppErrorBoundary from "./components/AppErrorBoundary";
import Toaster from "./components/Toaster";
import NoteIconBridge from "./components/NoteIconBridge";
import EmbedPasswordBridge from "./components/EmbedPasswordBridge";
import CameraCaptureBridge from "./components/CameraCaptureBridge";
import { initializeMobileLocalFirstRuntime } from "./lib/mobileLocalFirstRuntime";
import MediaExperienceBridge from "./components/MediaExperienceBridge";
import EditorImageTransformBridge from "./components/EditorImageTransformBridge";
import ImageClipboardBridge from "./components/ImageClipboardBridge";
import MarkdownMobileViewControlsBridge from "./components/MarkdownMobileViewControlsBridge";
import DesktopUpdateCenter from "./components/DesktopUpdateCenter";
import DockerUpdateCenter from "./components/DockerUpdateCenter";
import TwoFactorLoginChallengeCenter from "./components/TwoFactorLoginChallengeCenter";
import AndroidShareImportCenter from "./components/AndroidShareImportCenter";
import DeferredGlobalFeatureCentersMount from "./components/DeferredGlobalFeatureCentersMount";
import SiyuanRichTextCalloutBridge from "./components/SiyuanRichTextCalloutBridge";
import InlineCommentBridge from "./components/InlineCommentBridge";
import VoiceRecorderSheet from "./components/VoiceRecorderSheet";
import "./index.css";
import "./editor-list-markers.css";
import "./code-block-wrap.css";
import "./overlay-layers.css";
import "./space-actions.css";
import "./settings-switches.css";
import "./sidebar-search-experience.css";
import "./mobile-knowledge-tree-compact.css";
import "./siyuan-rich-text-callout.css";
import "./knowledge-tree-markdown-drop.css";
import "./inline-comments.css";
import "./loading-experience.css";
import "./note-appearance.css";
import { initCodeBlockTheme } from "./lib/codeBlockTheme";
import { installAndroidNativeHttpBridge } from "./lib/androidNativeHttpBridge";
import { installDesktopNativeHttpBridge } from "./lib/desktopNativeHttpBridge";
import { installMobileStartupBridge } from "./lib/mobileStartupBridge";
import { installMobileWebStartupBridge } from "./lib/mobileWebStartupBridge";
import { installNoteAttachmentAccessBridge } from "./lib/noteAttachmentAccessBridge";
import { installAttachmentUploadPolicyBridge } from "./lib/attachmentUploadPolicyBridge";
import { captureAttachmentAccessUpstreamFetch } from "./lib/attachmentAccessUpstreamFetch";
import { installNonBlockingNoteFetch } from "./lib/nonBlockingNoteFetch";
import { installReliableExportDownloadBridge } from "./lib/reliableExportDownloadBridge";
import { installNoteSyncSafety } from "./lib/noteSyncSafety";
import { installNoteUpdateResponseGuard } from "./lib/noteUpdateResponseGuard";
import { installNoteUpdateSerialQueue } from "./lib/noteUpdateSerialQueue";
import { installKnowledgeTreeTitleSyncBridge } from "./lib/knowledgeTreeTitleSyncBridge";
import { installKnowledgeTreeNoteLoadRecovery } from "./lib/knowledgeTreeNoteLoadRecovery";
import { installTaskAttachmentExportFallback } from "./lib/taskAttachmentExportFallback";
import { installTwoFactorLoginChallengeBridge } from "./lib/twoFactorLoginChallenge";
import { installTaskUpdateSafetyBridge } from "./lib/taskUpdateSafetyBridge";
import { installNodeViewMutationGuard } from "./lib/nodeViewMutationGuard";
import { installEditorMediaScopeGuard } from "./lib/editorMediaScopeGuard";
import { installRoundTripImportReviewBridge } from "./lib/roundTripImportReview";
import { installRoundTripPermissionExportBridge } from "./lib/roundTripPermissionExport";
import { installEditorPerformanceGlobal } from "./lib/editorPerformanceHarness";
import { installIssue210SignoffRuntime } from "./lib/issue210Signoff";
import { cleanupRemovedServerProfiles } from "./lib/removedServerProfileCleanup";
import { installKnowledgeTreeScrollbarBridge } from "./lib/knowledgeTreeScrollbarBridge";
import { installKnowledgeTreeMarkdownDrop } from "./lib/knowledgeTreeMarkdownDrop";
import { installInlineCommentTooltipMount } from "./lib/inlineCommentTooltipMount";
import { resolveCurrentAppPathname } from "./lib/appPathNavigation";
import { installUgreenCredentialedFetch } from "./lib/ugreenRemoteAccess";
import { observeBootSplashReadiness } from "./lib/bootSplash";
import { backfillLegacyStorageKeys } from "./lib/legacyStorageBackfill";

const App = React.lazy(() => import("./App"));
const PublicNotebookView = React.lazy(() => import("./components/PublicNotebookView"));

// 旧版 nowen-* localStorage 键回填，必须在任何业务模块读取存储之前执行。
backfillLegacyStorageKeys();

void cleanupRemovedServerProfiles();
installUgreenCredentialedFetch();

/**
 * The HTML startup card stays above React while lazy modules, auth restoration and quick
 * login probing are running. Once a real route or interactive surface mounts, this observer
 * dismisses it with the minimum-visible-time guard from bootSplash.ts.
 */
function BootSplashReadinessObserver() {
  React.useEffect(() => observeBootSplashReadiness(document.getElementById("root")), []);
  return null;
}

/**
 * Suspense must stay visually silent during cold start. The HTML startup card already owns
 * that feedback; rendering another centered spinner here caused the second loading screen.
 */
function MainRouteFallback() {
  return null;
}

installKnowledgeTreeScrollbarBridge();
installKnowledgeTreeMarkdownDrop();
installNodeViewMutationGuard();
installEditorMediaScopeGuard();
installAndroidNativeHttpBridge();
installDesktopNativeHttpBridge();
installMobileStartupBridge();
installMobileWebStartupBridge();
// 附件上传统一边界：服务端策略在运行时拉取，改大小上限不需要前端重新构建；
// 必须在任何编辑器开始上传附件之前安装。
installAttachmentUploadPolicyBridge();
// 先捕获上传链路（在有附件的 note 详情等待逻辑之前），让正文先渲染、签名媒体访问在后台准备。
captureAttachmentAccessUpstreamFetch();
installNoteAttachmentAccessBridge();
installNonBlockingNoteFetch();
installTwoFactorLoginChallengeBridge();
installNoteSyncSafety();
installNoteUpdateResponseGuard();
installNoteUpdateSerialQueue();
installKnowledgeTreeTitleSyncBridge();
installKnowledgeTreeNoteLoadRecovery();
installTaskAttachmentExportFallback();
installTaskUpdateSafetyBridge();
installReliableExportDownloadBridge();
installRoundTripImportReviewBridge();
installRoundTripPermissionExportBridge();
installEditorPerformanceGlobal();
installIssue210SignoffRuntime();
installInlineCommentTooltipMount();

initCodeBlockTheme();

const THEME_KEY = "baseforge-theme";
if (typeof localStorage !== "undefined" && !localStorage.getItem(THEME_KEY)) {
  localStorage.setItem(THEME_KEY, "light");
}

try {
  const desk: any = (window as any).baseforgeDesktop;
  if (desk && desk.isDesktop && typeof desk.platform === "string") {
    document.documentElement.setAttribute("data-electron", desk.platform);
  }
} catch {
  /* 纯 Web 环境：静默 */
}

function resolvePublicNotebookRoute(): { matched: boolean; token?: string } {
  const match = resolveCurrentAppPathname().match(/^\/public(?:\/([^/]+))?\/?$/);
  if (!match) return { matched: false };
  if (!match[1]) return { matched: true };
  try {
    return { matched: true, token: decodeURIComponent(match[1]) };
  } catch {
    return { matched: true, token: match[1] };
  }
}

const publicRoute = resolvePublicNotebookRoute();

/**
 * dev 下等本地后端就绪再渲染：vite 常先于后端可用，首屏那批 /api 请求会全部撞上
 * ECONNREFUSED（后端还在 tsx 编译/迁移/重启窗口）。探测走 vite 的
 * `/__dev/backend-ready` 中间件（失败不经过代理，不会刷屏 proxy error），等待期由
 * index.html 的启动闪屏承载；超时后照常渲染，不阻塞用户。
 * 生产构建下 import.meta.env.DEV 为 false，直接返回。
 */
async function waitForDevBackendReady(timeoutMs = 30_000): Promise<void> {
  if (!import.meta.env.DEV) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("/__dev/backend-ready", { cache: "no-store" });
      if (res.ok) return;
    } catch {
      // 后端尚未监听，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function renderApplication(): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SiteSettingsProvider>
      <ConfirmProvider>
        <BootSplashReadinessObserver />
        {publicRoute.matched ? (
          <ThemeProvider>
            <React.Suspense fallback={<MainRouteFallback />}>
              <PublicNotebookView token={publicRoute.token} />
            </React.Suspense>
            <Toaster />
          </ThemeProvider>
        ) : (
          <>
            <NoteIconBridge />
            <EmbedPasswordBridge />
            <CameraCaptureBridge />
            <MediaExperienceBridge />
            <EditorImageTransformBridge />
            <ImageClipboardBridge />
            <MarkdownMobileViewControlsBridge />
            <DesktopUpdateCenter />
            <DockerUpdateCenter />
            <TwoFactorLoginChallengeCenter />
            <AndroidShareImportCenter />
            <DeferredGlobalFeatureCentersMount />
            <SiyuanRichTextCalloutBridge />
            <InlineCommentBridge />
            {/* 语音备忘录制面板：全局单例，监听 "baseforge:voice-record" 事件弹出 */}
            <VoiceRecorderSheet />
            <AppErrorBoundary>
              <React.Suspense fallback={<MainRouteFallback />}>
                <App />
              </React.Suspense>
            </AppErrorBoundary>
          </>
        )}
      </ConfirmProvider>
    </SiteSettingsProvider>
  </React.StrictMode>,
  );
}

// 移动端本地优先运行时是增强能力：原生桥不可用（纯 Web/桌面）时必须照常渲染。
Promise.resolve()
  .then(() => waitForDevBackendReady())
  .then(() => initializeMobileLocalFirstRuntime())
  .then(renderApplication, () => renderApplication());
