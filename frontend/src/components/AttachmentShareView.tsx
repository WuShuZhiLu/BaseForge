/**
 * 附件分享访客落地页（/fs/:token）
 * ---------------------------------------------------------------------------
 * 在此之前，附件分享链接直接指向 `/attachment-shares/:token/content`：
 * 无密码分享是裸下载流（访客看不到任何信息），带密码分享打开只会得到一段
 * `{"error":"需要密码验证"}` JSON。这里补上访客侧的三态：密码门 / 预览下载 / 已失效。
 *
 * 后端刻意对匿名访客把「已关闭 / 已过期 / 次数耗尽 / 不存在」统一成 404，
 * 所以失效态只给一句不泄露状态的话，不区分原因。
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, ExternalLink, FileText, Loader2, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { attachmentSharePublicApi, type AttachmentShareMeta } from "@/lib/attachmentShareApi";

type Phase = "loading" | "invalid" | "gate" | "ready";

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function expiryHint(expiresAt: string | null): string {
  if (!expiresAt) return "此链接长期有效";
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return "此链接有有效期";
  const days = Math.round((at - Date.now()) / 86_400_000);
  if (at <= Date.now()) return "此链接已过期";
  if (days <= 0) return "此链接今天到期";
  return days === 1 ? "此链接明天到期" : `此链接 ${days} 天后到期`;
}

export default function AttachmentShareView({ shareToken }: { shareToken: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [meta, setMeta] = useState<AttachmentShareMeta | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [gateError, setGateError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    attachmentSharePublicApi.meta(shareToken)
      .then(async (data) => {
        if (cancelled) return;
        setMeta(data);
        if (data.needPassword) {
          setPhase("gate");
          return;
        }
        // 无密码分享也要拿访问凭证：content 端点统一凭它读取，逻辑只有一条。
        const result = await attachmentSharePublicApi.verify(shareToken);
        if (cancelled) return;
        setAccessToken(result.accessToken);
        setPhase("ready");
      })
      .catch((error: any) => {
        if (cancelled) return;
        if (error?.status === 404) {
          setPhase("invalid");
          return;
        }
        if (error?.status === 401 || error?.status === 403) {
          setPhase("gate");
          return;
        }
        setGateError(error?.message || "无法打开分享链接");
        setPhase("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  const isImage = Boolean(meta?.mimeType.startsWith("image/"));
  const isPdf = meta?.mimeType === "application/pdf";

  /** 带凭证的资源只能取回 blob（<img>/<iframe> 的 src 加不了 Authorization 头）。 */
  const loadPreview = useCallback(async () => {
    if (!meta || previewUrl) return;
    setBusy(true);
    setActionError("");
    try {
      const blob = await attachmentSharePublicApi.fetchContent(shareToken, accessToken);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (error: any) {
      setActionError(error?.message || "预览加载失败");
    } finally {
      setBusy(false);
    }
  }, [accessToken, meta, previewUrl, shareToken]);

  useEffect(() => {
    // 图片是访客页最常见的情形，直接加载；PDF 体积可能很大，由访客点「在线预览」再拉。
    if (phase === "ready" && meta && isImage) void loadPreview();
  }, [isImage, loadPreview, meta, phase]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const submitPassword = async () => {
    if (checking) return;
    if (password.trim().length < 4) {
      setGateError("请输入至少 4 位访问密码");
      return;
    }
    setChecking(true);
    setGateError("");
    try {
      const result = await attachmentSharePublicApi.verify(shareToken, password.trim());
      setAccessToken(result.accessToken);
      setPhase("ready");
    } catch (error: any) {
      setGateError(error?.status === 429
        ? "验证尝试过于频繁，请稍后再试"
        : error?.message || "验证失败，请重试");
    } finally {
      setChecking(false);
    }
  };

  const download = async () => {
    if (!meta || busy) return;
    setBusy(true);
    setActionError("");
    try {
      const blob = await attachmentSharePublicApi.fetchContent(shareToken, accessToken, true);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = meta.filename || "download";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // 大文件下载完成后立即释放，避免 blob 常驻内存
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error: any) {
      setActionError(error?.message || "下载失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-app-bg text-tx-primary flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-3xl">
        <div className="mb-4 flex items-center gap-2 text-sm text-tx-tertiary">
          <ShieldCheck size={15} />
          <span>BaseForge 分享</span>
        </div>

        <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-sm">
          {phase === "loading" ? (
            <div className="flex items-center justify-center py-16 text-sm text-tx-secondary">
              <Loader2 size={16} className="mr-2 animate-spin" />正在打开分享…
            </div>
          ) : phase === "invalid" ? (
            <div className="py-10 text-center">
              <AlertTriangle size={28} className="mx-auto text-amber-500" />
              <h1 className="mt-3 text-lg font-semibold">链接不存在或已失效</h1>
              <p className="mt-2 text-sm text-tx-secondary">
                {gateError || "分享可能已被撤销、过期，或访问次数已用完。请让对方重新生成链接。"}
              </p>
            </div>
          ) : phase === "gate" ? (
            <div className="mx-auto max-w-sm py-6">
              <Lock size={24} className="mx-auto text-accent-primary" />
              <h1 className="mt-3 text-center text-lg font-semibold">这份分享需要密码</h1>
              <p className="mt-1 text-center text-sm text-tx-secondary">
                {meta ? `《${meta.filename}》由分享者设了访问保护。` : "请输入对方提供的访问密码。"}
              </p>
              <div className="mt-4 space-y-2">
                <Input
                  type="password"
                  autoFocus
                  value={password}
                  placeholder="访问密码"
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void submitPassword(); }}
                />
                {gateError && <p className="text-xs text-rose-600 dark:text-rose-300">{gateError}</p>}
                <Button className="w-full" disabled={checking} onClick={() => void submitPassword()}>
                  {checking ? <Loader2 size={15} className="mr-1.5 animate-spin" /> : null}
                  验证并查看
                </Button>
              </div>
            </div>
          ) : meta ? (
            <>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0 rounded-lg bg-app-hover p-2.5 text-tx-secondary"><FileText size={18} /></span>
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-base font-semibold">{meta.filename}</h1>
                  <p className="mt-1 text-xs text-tx-tertiary">
                    {[meta.mimeType, formatSize(meta.size)].filter(Boolean).join(" · ")}
                  </p>
                  <p className="mt-1 text-xs text-tx-tertiary">{expiryHint(meta.expiresAt)}</p>
                </div>
              </div>

              {actionError && (
                <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                  {actionError}
                </p>
              )}

              {previewUrl && isImage ? (
                <div className="mt-4 overflow-auto rounded-lg border border-app-border bg-app-bg p-3">
                  <img src={previewUrl} alt={meta.filename} className="mx-auto max-h-[70vh] max-w-full object-contain" />
                </div>
              ) : previewUrl && isPdf ? (
                <div className="mt-4 h-[70vh] overflow-hidden rounded-lg border border-app-border">
                  <iframe title={meta.filename} src={previewUrl} className="h-full w-full" />
                </div>
              ) : isImage ? (
                <div className="mt-4 flex items-center justify-center rounded-lg border border-app-border py-16 text-sm text-tx-secondary">
                  <Loader2 size={16} className="mr-2 animate-spin" />正在加载预览…
                  {actionError && (
                    <Button size="sm" variant="outline" className="ml-3" onClick={() => void loadPreview()}>重试</Button>
                  )}
                </div>
              ) : isPdf ? (
                <p className="mt-4 text-sm text-tx-secondary">预览需要先把完整文件拉到本地，确认后再加载。</p>
              ) : (
                <p className="mt-4 text-sm text-tx-secondary">该文件类型不支持在线预览，可直接下载。</p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => void download()} disabled={busy}>
                  {busy ? <Loader2 size={15} className="mr-1.5 animate-spin" /> : <Download size={15} className="mr-1.5" />}
                  下载文件
                </Button>
                {isPdf && !previewUrl && (
                  <Button variant="outline" onClick={() => void loadPreview()} disabled={busy}>
                    <ExternalLink size={15} className="mr-1.5" />
                    在线预览
                  </Button>
                )}
                {previewUrl && (
                  <Button variant="outline" onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}>
                    <ExternalLink size={15} className="mr-1.5" />
                    在新标签打开
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </div>

        <p className="mt-3 text-center text-xs text-tx-tertiary">
          文件由分享者上传，BaseForge 不参与内容审核。若内容侵权，请联系分享者撤销该链接。
        </p>
      </div>
    </div>
  );
}
