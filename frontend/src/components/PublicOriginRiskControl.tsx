/**
 * 公开分享地址风险提示 + 配置入口。
 *
 * 原型 share-redesign-v1 把这条提示放在左栏（「⚠ 公开地址待验证」提示框），
 * 主区只放列表，所以这里抽成独立组件供侧栏使用。侧栏是窄栏且自身 overflow-y-auto，
 * 展开面板用 fixed 定位贴在触发元素右侧，避免被裁掉。
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Copy, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import {
  getPublicWebOriginSourceLabel,
  resolvePublicWebOrigin,
  type PublicWebOriginResolution,
} from "@/lib/publicWebOrigin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function getOriginRiskCopy(publicOrigin: PublicWebOriginResolution) {
  switch (publicOrigin.risk) {
    case "localhost":
      return {
        label: "分享地址仅本机可访问",
        message: "当前分享地址为 localhost，仅本机可访问。",
      };
    case "private-network":
      return {
        label: "分享地址可能仅限内网",
        message: "当前分享地址可能仅限局域网或 VPN 内访问，外部访客可能无法打开。",
      };
    case "protected-gateway":
      return {
        label: "分享地址可能需要登录",
        message: "当前分享地址可能经过登录网关，未登录访客可能无法打开。",
      };
    default:
      return {
        label: "公开地址待验证",
        message: "公开分享地址尚未验证，建议使用无痕窗口或未登录设备测试。",
      };
  }
}

/** 展开面板的 fixed 坐标：贴住触发元素右侧，越界时向左收。 */
function panelPosition(anchor: HTMLElement | null) {
  if (!anchor) return undefined;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 24);
  const left = Math.min(Math.max(12, rect.right + 8), Math.max(12, window.innerWidth - width - 12));
  const top = Math.max(12, Math.min(rect.top, window.innerHeight - 340));
  return { left, top, width };
}

export function PublicOriginRiskControl({ variant }: { variant: "badge" | "box" }) {
  const { siteConfig, updatePublicWebOrigin } = useSiteSettings();
  const [open, setOpen] = useState(false);
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [originDraft, setOriginDraft] = useState(siteConfig.publicWebOrigin);
  const [saving, setSaving] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number }>();
  const rootRef = useRef<HTMLDivElement>(null);

  const publicOrigin = resolvePublicWebOrigin({
    runtimeOrigin: siteConfig.publicWebOrigin,
    runtimeSource: siteConfig.publicWebOriginSource,
  });
  const copy = getOriginRiskCopy(publicOrigin);

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((user) => {
        if (!cancelled) setCanManage(user.role === "admin");
      })
      .catch(() => {
        if (!cancelled) setCanManage(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setOriginDraft(siteConfig.publicWebOrigin);
  }, [siteConfig.publicWebOrigin]);

  useEffect(() => {
    if (!open) return;
    setPosition(panelPosition(rootRef.current));
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handleResize = () => setPosition(panelPosition(rootRef.current));
    window.addEventListener("resize", handleResize);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown, { passive: true });
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown, { passive: true } as EventListenerOptions);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const saveOrigin = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updatePublicWebOrigin(originDraft.trim());
      toast.success(originDraft.trim() ? "公开分享地址已保存" : "已恢复容器环境变量或当前访问域名");
      setOpen(false);
    } catch (error: any) {
      toast.error(error?.message || "公开分享地址保存失败");
    } finally {
      setSaving(false);
    }
  };

  const copyOrigin = async () => {
    if (!publicOrigin.origin) return;
    const ok = await copyText(publicOrigin.origin);
    if (ok) {
      toast.success("公开分享地址已复制");
    } else {
      toast.error("复制失败，请手动复制");
    }
  };

  const panel = open && (
    <div
      role="dialog"
      aria-label="公开分享地址详情"
      style={position}
      className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-app-border bg-app-elevated p-4 text-left shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-tx-primary">{copy.label}</p>
          <p className="mt-1 text-xs leading-5 text-tx-secondary">{copy.message}</p>
        </div>
        <button
          type="button"
          aria-label="关闭公开地址详情"
          onClick={() => setOpen(false)}
          className="rounded-md p-1 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
        >
          <X size={15} />
        </button>
      </div>

      <div className="mt-3 rounded-lg bg-app-hover/60 p-3">
        <div className="flex items-center justify-between gap-3 text-[11px] text-tx-tertiary">
          <span>地址来源</span>
          <span>{getPublicWebOriginSourceLabel(publicOrigin.source)}</span>
        </div>
        <div className="mt-2 flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all text-xs text-tx-secondary">
            {publicOrigin.origin || "相对地址"}
          </code>
          {publicOrigin.origin && (
            <button
              type="button"
              aria-label="复制公开分享地址"
              title="复制公开分享地址"
              onClick={() => void copyOrigin()}
              className="shrink-0 rounded-md p-1 text-tx-tertiary transition-colors hover:bg-app-surface hover:text-tx-primary"
            >
              <Copy size={14} />
            </button>
          )}
        </div>
      </div>

      {canManage ? (
        <div className="mt-3">
          <label className="text-xs font-medium text-tx-secondary" htmlFor="share-public-origin">
            独立公开地址
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="share-public-origin"
              value={originDraft}
              onChange={(event) => setOriginDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveOrigin();
              }}
              placeholder="https://note.example.com"
              className="h-9 min-w-0 flex-1 text-xs"
            />
            <Button size="sm" disabled={saving} onClick={() => void saveOrigin()} className="h-9 shrink-0">
              {saving && <Loader2 size={13} className="mr-1 animate-spin" />}
              保存
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-tx-tertiary">
            留空后优先恢复容器 PUBLIC_WEB_ORIGIN；仍未配置时使用当前访问域名。
          </p>
        </div>
      ) : canManage === false ? (
        <p className="mt-3 text-xs leading-5 text-tx-tertiary">
          当前账号无权修改，请让管理员配置独立公开地址或 PUBLIC_WEB_ORIGIN。
        </p>
      ) : (
        <div className="mt-3 flex items-center text-xs text-tx-tertiary">
          <Loader2 size={13} className="mr-1.5 animate-spin" />
          正在检查配置权限…
        </div>
      )}

      <p className="mt-3 border-t border-app-border pt-3 text-[11px] leading-4 text-tx-tertiary">
        配置完成后，仍建议使用无痕窗口或未登录设备验证一次。
      </p>
    </div>
  );

  if (variant === "box") {
    return (
      <div ref={rootRef} className="rounded-lg border border-amber-500/40 bg-amber-500/[0.08] p-2.5 text-[11px] leading-5 text-amber-800 dark:text-amber-200">
        <p className="flex items-center gap-1.5 font-medium">
          <AlertTriangle size={13} /> {copy.label}
        </p>
        <p className="mt-1">{copy.message}</p>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="mt-1.5 text-accent-primary underline-offset-4 hover:underline"
        >
          配置公开地址 →
        </button>
        {panel}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={cn("relative", "shrink-0")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/10 dark:text-amber-200"
      >
        <AlertTriangle size={14} />
        {copy.label}
      </button>
      {panel}
    </div>
  );
}

export default PublicOriginRiskControl;
