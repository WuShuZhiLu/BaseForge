/**
 * 分享中心（原「分享管理」页）
 * ---------------------------------------------------------------------------
 * 把 5 条互不相通的分享通道收成一个列表：笔记 shares、附件 attachment_shares、
 * 稳定文件直链 file_shares、目录邀请链接 notebook_share_links、目录公开出版
 * notebook_publications。后三条此前没有任何管理界面，链接撤不掉。
 *
 * 左栏徽标数字来自后端 counts，而 counts 与列表同源（同一集合统计），因此
 * 「点进去的条数 = 徽标数」；页面不再自己按 status 分类计数。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BookOpen,
  ChevronDown,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  MessageSquareText,
  Paperclip,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Search,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import ShareModal from "@/components/ShareModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/components/ui/confirm";
import { useApp } from "@/store/AppContext";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { api } from "@/lib/api";
import { attachmentShareApi } from "@/lib/attachmentShareApi";
import type { ToolPageHeaderMode } from "@/lib/toolPage";
import { navigateToolPage } from "@/components/toolTabs";

/** 页签契约：页面自带标题行（分享中心 header），宿主顶栏无需重复渲染。 */
export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own";

import { copyText } from "@/lib/clipboard";
import { openCommentCenter } from "@/lib/noteCommentNavigation";
import {
  buildPublicWebUrl,
  resolvePublicWebOrigin,
  type PublicWebOriginOptions,
  type PublicWebOriginResolution,
} from "@/lib/publicWebOrigin";
import { getOriginRiskCopy } from "@/components/PublicOriginRiskControl";
import {
  getShareCenterUiVersion,
  getShareGroup,
  getShareObjectKind,
  getShareQuick,
  getShareRisk,
  getShareSort,
  setShareCenterUi,
  shareGroupTitle,
  shareQuickQuery,
  SHARE_QUICK_CHIPS,
  SHARE_SORT_OPTIONS,
  subscribeShareCenterUi,
  takeShareCenterFocus,
} from "@/features/shares/shareCenterUi";
import { compactShareToken, formatShareDate } from "@/lib/shareManagement";
import {
  formatShareExpiry,
  formatShareLastSeen,
  formatShareViews,
  SHARE_DEFAULT_EXPIRY_DAYS,
  shareAccessLabel,
  shareCenterApi,
  shareExpiresInDays,
  shareObjectKindLabel,
  sharePermissionLabel,
  shareStatusMeta,
  type ShareCenterBatchAction,
  type ShareCenterCounts,
  type ShareCenterItem,
  type ShareCenterResponse,
  type ShareCenterVisit,
} from "@/lib/shareCenter";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
/** 选中项的主键：同一 id 只在其通道内唯一。 */
const itemKey = (item: Pick<ShareCenterItem, "channel" | "id">) => `${item.channel}|${item.id}`;

const OBJECT_ICONS = { note: FileText, file: Paperclip, notebook: BookOpen } as const;

/** 从 UA 里抽「浏览器 · 系统」，抽不出就回「未知设备」——访问明细不展示原始 UA。 */
function describeUserAgent(ua: string | null): string {
  if (!ua) return "未知设备";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
      : /Chrome\//.test(ua) ? "Chrome"
        : /Safari\//.test(ua) ? "Safari"
          : /Firefox\//.test(ua) ? "Firefox"
            : "";
  const os = /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
      : /Android/.test(ua) ? "Android"
        : /iPhone|iPad/.test(ua) ? "iOS"
          : /Linux/.test(ua) ? "Linux"
            : "";
  if (browser && os) return `${browser} · ${os}`;
  return browser || os || "未知设备";
}

function StatusBadge({ status, channel }: { status: ShareCenterItem["status"]; channel: ShareCenterItem["channel"] }) {
  // 裸直链没有「有效期/停用」这些状态，它天生永久且不可撤销
  if (channel === "attachment_bare") {
    return <span className="inline-flex rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-700 dark:text-rose-300">裸直链</span>;
  }
  const meta = shareStatusMeta(status);
  return <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", meta.className)}>{meta.label}</span>;
}

function IconAction({ label, onClick, danger = false, children }: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-app-border bg-app-surface transition-colors hover:bg-app-hover",
        danger ? "text-rose-600 dark:text-rose-300" : "text-tx-secondary hover:text-tx-primary",
      )}
    >
      {children}
    </button>
  );
}

export default function ShareManagementPage() {
  const { siteConfig } = useSiteSettings();
  const { state } = useApp();
  const [data, setData] = useState<ShareCenterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<string, ShareCenterItem>>(new Map());
  const [detail, setDetail] = useState<ShareCenterItem | null>(null);
  const [editingNoteShare, setEditingNoteShare] = useState<ShareCenterItem | null>(null);
  const [creatingShare, setCreatingShare] = useState<{ noteId: string; title: string } | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const requestSequence = useRef(0);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // 排序菜单的外部点击关闭（原型是「排序：最近访问 ▾」的下拉）
  useEffect(() => {
    if (!sortMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) setSortMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [sortMenuOpen]);

  // 分类与筛选放在共享 store：左侧栏点分类、主区换列表，两边看到的是同一份状态
  // （照 features/files/filesUi.ts 的 useSyncExternalStore 模式）。
  const uiVersion = useSyncExternalStore(subscribeShareCenterUi, getShareCenterUiVersion, getShareCenterUiVersion);
  const group = useMemo(() => getShareGroup(), [uiVersion]);
  const objectKind = useMemo(() => getShareObjectKind(), [uiVersion]);
  const risk = useMemo(() => getShareRisk(), [uiVersion]);
  const quick = useMemo(() => getShareQuick(), [uiVersion]);
  const sort = useMemo(() => getShareSort(), [uiVersion]);
  /** 排序方向固定：标题正序（A→Z），其余一律降序（最近/最新优先）。 */
  const order: "asc" | "desc" = sort === "title" ? "asc" : "desc";

  const publicOrigin = resolvePublicWebOrigin({
    runtimeOrigin: siteConfig.publicWebOrigin,
    runtimeSource: siteConfig.publicWebOriginSource,
  });
  const originOptions = {
    runtimeOrigin: siteConfig.publicWebOrigin,
    runtimeSource: siteConfig.publicWebOriginSource,
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(searchDraft.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const load = useCallback(async (silent = false) => {
    const sequence = ++requestSequence.current;
    if (!silent) setLoading(true);
    setError("");
    try {
      const response = await shareCenterApi.list({
        q: query || undefined,
        group: group === "all" ? undefined : group,
        objectKind: objectKind === "all" ? undefined : objectKind,
        risk: risk === "all" ? undefined : risk,
        ...shareQuickQuery(quick),
        sort,
        order,
        page,
        pageSize: PAGE_SIZE,
      });
      if (sequence === requestSequence.current) {
        setData(response);
        // 批量选择跨页保留；这里只用最新结果同步**已选中**的项（可能已被其它端改动），
        // 不能把本页所有项都并进选中集。
        setSelected((current) => {
          if (current.size === 0) return current;
          const fresh = new Map(response.items.map((item) => [itemKey(item), item]));
          const next = new Map(current);
          for (const key of current.keys()) {
            const updated = fresh.get(key);
            if (updated) next.set(key, updated);
          }
          return next;
        });
      }
    } catch (loadError: any) {
      if (sequence === requestSequence.current) {
        setError(loadError?.message || "加载分享列表失败");
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
      }
    }
  }, [group, objectKind, order, page, query, quick, risk, sort]);

  useEffect(() => { void load(); }, [load]);

  // 其它页面（附件列表行内「分享」）会把「要看哪一条」寄存在共享 store：
  // 这里消费一次就打开同一抽屉，不另开一套对话框（原型落地顺序第 3 条）。
  useEffect(() => {
    const target = takeShareCenterFocus();
    if (!target) return;
    let cancelled = false;
    shareCenterApi.item(target.channel, target.objectId)
      .then((result) => {
        if (cancelled) return;
        if (result.item) setDetail(result.item);
        else toast.warning("这条分享已不存在，可能刚被删除或停用");
      })
      .catch((focusError: any) => {
        if (!cancelled) toast.error(focusError?.message || "无法定位这条分享");
      });
    return () => { cancelled = true; };
  }, [uiVersion]);
  // 分类 / 快捷筛选 / 排序变化后回到第一页；page 变化会再触发一次加载，请求序号保证只用最后一次结果。
  const filterKey = `${group}|${objectKind}|${risk}|${quick}|${sort}|${query}`;
  useEffect(() => { setPage(1); }, [filterKey]);
  useEffect(() => {
    const onWorkspaceChanged = () => {
      setPage(1);
      void load(true);
    };
    window.addEventListener("nowen:workspace-changed", onWorkspaceChanged);
    return () => window.removeEventListener("nowen:workspace-changed", onWorkspaceChanged);
  }, [load]);

  const counts: ShareCenterCounts = data?.counts || {
    total: 0,
    groups: { active: 0, attention: 0, disabled: 0 },
    statuses: { active: 0, disabled: 0, expired: 0, exhausted: 0, orphan: 0 },
    objects: { note: 0, file: 0, notebook: 0 },
    risks: { open_ended: 0, orphan: 0, unused: 0, bare: 0 },
  };
  const pageCount = Math.max(1, Math.ceil((data?.total || 0) / PAGE_SIZE));
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const items = data?.items || [];
  /** 裸直链行不能停用/删除，全选与批量条都要把它们排除。 */
  const selectableItems = items.filter((item) => item.channel !== "attachment_bare");
  const shareUrl = (item: ShareCenterItem) => buildPublicWebUrl(item.urlPath, originOptions);

  const copyLink = async (item: ShareCenterItem) => {
    const ok = await copyText(shareUrl(item));
    if (ok) {
      toast.success("分享链接已复制");
    } else {
      toast.error("复制失败，请手动复制");
    }
  };

  const toggleSelected = (item: ShareCenterItem) => {
    setSelected((current) => {
      const next = new Map(current);
      const key = itemKey(item);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  };

  const targets = useMemo(
    () => Array.from(selected.values()).map((item) => ({ channel: item.channel, id: item.id })),
    [selected],
  );

  const runBatch = useCallback(async (action: ShareCenterBatchAction, list = targets, expiresAt?: string) => {
    if (list.length === 0) return;
    try {
      const result = await shareCenterApi.batch(action, list, expiresAt);
      const done = {
        disable: "已停用",
        delete: "已删除",
        expire: "已设置过期时间",
      }[action];
      if (result.failed > 0) {
        toast.warning(`${done} ${result.succeeded} 项，${result.failed} 项无权限或已不存在`);
      } else {
        toast.success(`${done} ${result.succeeded} 项`);
      }
      setSelected(new Map());
      setDetail(null);
      await load(true);
    } catch (batchError: any) {
      toast.error(batchError?.message || "批量操作失败");
    }
  }, [load, targets]);

  const batchDisable = async () => {
    if (!await confirm({
      title: `停用选中的 ${targets.length} 项分享？`,
      description: "访客将立即无法访问，分享记录保留，可随时重新启用（部分通道不支持）。",
    })) return;
    await runBatch("disable");
  };

  const batchExpire = async () => {
    await runBatch("expire", targets, shareExpiresInDays(30));
  };

  const batchDelete = async () => {
    if (!await confirm({
      title: `删除选中的 ${targets.length} 项分享？`,
      description: "链接立即失效且不可恢复。目录邀请链接会同时移除经它加入的协作者。",
      danger: true,
    })) return;
    await runBatch("delete");
  };

  const batchCopy = async () => {
    const links = Array.from(selected.values()).map((item) => shareUrl(item));
    if (links.length === 0) return;
    const ok = await copyText(links.join("\n"));
    if (ok) toast.success(`已复制 ${links.length} 条链接`);
    else toast.error("复制失败，请手动复制");
  };

  const enableShare = async (item: ShareCenterItem) => {
    // 重新启用只有笔记 / 附件两条通道有原端点，其余沿用各自对话框。
    if (item.channel === "note_share") {
      await api.updateShare(item.id, { isActive: 1 });
    } else if (item.channel === "attachment_share") {
      await attachmentShareApi.update(item.id, { isActive: true });
    } else {
      toast.info("该通道暂不支持重新启用，请到来源界面重新创建分享");
      return;
    }
    toast.success("分享已启用");
    await load(true);
  };

  const toggleOne = async (item: ShareCenterItem) => {
    if (!item.isActive) {
      await enableShare(item);
      return;
    }
    if (!await confirm({
      title: "停用分享链接？",
      description: "访客将立即无法访问。目录邀请链接还会移除经它加入的协作者。",
      danger: true,
    })) return;
    await runBatch("disable", [{ channel: item.channel, id: item.id }]);
  };

  const deleteOne = async (item: ShareCenterItem) => {
    if (!await confirm({
      title: "删除分享链接？",
      description: "链接立即失效且不可恢复，此操作不可撤销。",
      danger: true,
    })) return;
    await runBatch("delete", [{ channel: item.channel, id: item.id }]);
  };

  const openOrigin = (item: ShareCenterItem) => {
    if (item.channel !== "note_share") return;
    if (item.objectMissing || item.objectTrashed) {
      toast.warning(item.objectMissing ? "原笔记已不存在" : "原笔记位于回收站中");
      return;
    }
    void (async () => {
      try {
        // 页签契约（P3）：不调 actions.setViewMode，改派发 nowen:tool-page-navigate
        // 由 ToolPageHost 翻译为「关闭工具页签 + 打开笔记」。
        await api.getNote(item.objectId);
        navigateToolPage({ kind: "note", noteId: item.objectId });
      } catch (openError: any) {
        toast.error(openError?.message || "无法打开原笔记");
      }
    })();
  };

  const openVisitorPage = (item: ShareCenterItem) => {
    window.open(shareUrl(item), "_blank", "noopener,noreferrer");
  };

  const renderAccess = (item: ShareCenterItem) => {
    if (item.channel === "attachment_bare") {
      return (
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1 text-xs font-medium text-rose-600 dark:text-rose-300">
            <Unlock size={13} /> 任何人可见 · 无需登录
          </p>
          <p className="truncate text-tx-secondary">知道地址即可永久访问，不可撤销</p>
          <p className="mt-0.5 truncate text-[11px] text-tx-tertiary">笔记插图自带直链，关掉会让笔记里的图裂开</p>
        </div>
      );
    }
    const openEnded = item.risks.includes("open_ended");
    const fine: string[] = [];
    if (item.hasPassword) fine.push("已设密码");
    if (item.maxViews !== null) fine.push(`上限 ${item.maxViews} 会话`);
    if (item.channel === "file_share") fine.push("来源：复制内容时自动升级的稳定链接");
    if (item.channel === "notebook_publication" && item.capabilities) {
      const caps = [
        item.capabilities.download ? "允许下载" : "禁止下载",
        item.capabilities.comment ? "允许游客评论" : "禁止评论",
        item.capabilities.reshare ? "允许二次分享" : "禁止二次分享",
      ];
      fine.push(caps.join(" · "));
    }
    if (item.objectTrashed) fine.push("原笔记在回收站，访客仍可能看到缓存");
    if (item.objectMissing) fine.push("原对象已删除，建议立即清理");
    return (
      <div className="min-w-0">
        {openEnded && (
          <p className="inline-flex items-center gap-1 text-xs font-medium text-rose-600 dark:text-rose-300">
            <Unlock size={13} /> 任何人可见 · 无密码 · 永久
          </p>
        )}
        <p className="truncate text-tx-secondary">
          {openEnded ? "建议加密码或设有效期" : `${shareAccessLabel(item.access)} · ${sharePermissionLabel(item.permission)}`}
        </p>
        {fine.length > 0 && <p className="mt-0.5 truncate text-[11px] text-tx-tertiary">{fine.join(" · ")}</p>}
      </div>
    );
  };

  const renderRowActions = (item: ShareCenterItem) => {
    // 裸直链只能看和复制：没有可停用/可删除的分享对象
    if (item.channel === "attachment_bare") {
      return (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <IconAction label="复制直链" onClick={() => void copyLink(item)}><Copy size={14} /></IconAction>
          <IconAction label="打开直链" onClick={() => openVisitorPage(item)}><ExternalLink size={14} /></IconAction>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <IconAction label="复制链接" onClick={() => void copyLink(item)}><Copy size={14} /></IconAction>
        <IconAction label="打开访客页" onClick={() => openVisitorPage(item)}><ExternalLink size={14} /></IconAction>
        {item.channel === "note_share" && (
          <>
            <IconAction label="打开原笔记" onClick={() => openOrigin(item)}><FileText size={14} /></IconAction>
            <IconAction label="编辑分享设置" onClick={() => setEditingNoteShare(item)}><Pencil size={14} /></IconAction>
          </>
        )}
        <IconAction label={item.isActive ? "停用分享" : "启用分享"} onClick={() => void toggleOne(item)}>
          {item.isActive ? <PowerOff size={14} /> : <Power size={14} />}
        </IconAction>
        <IconAction label="删除分享" danger onClick={() => void deleteOne(item)}><Trash2 size={14} /></IconAction>
      </div>
    );
  };

  /** 抽屉里改完密码 / 上限后，列表与抽屉各自重拉一份（抽屉拿的是快照）。 */
  const refreshDetail = async () => {
    if (!detail) return;
    try {
      const result = await shareCenterApi.item(detail.channel, detail.objectId);
      if (result.item) setDetail(result.item);
    } catch {
      // 单条刷新失败不打断用户：列表那边已经弹过一次错
    }
  };

  // 原型是单个主按钮：分享必须有对象，直接开当前笔记的分享对话框。
  // 文件 / 目录的分享入口在它们自己的界面里（原型落地顺序第 3 条）。
  const shareActiveNote = () => {
    const note = state.activeNote;
    if (!note) {
      toast.info("先在编辑器里打开要分享的笔记");
      return;
    }
    setCreatingShare({ noteId: note.id, title: note.title || "未命名笔记" });
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg">
      {/* 标题行：当前分类 + 条数（条数取本次列表 total，与列表同源） */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-app-border px-4">
        <h1 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-tx-primary">
          <Link2 size={17} className="shrink-0 text-accent-primary" />
          <span className="truncate">{shareGroupTitle(group)}</span>
          <span className="shrink-0 rounded-full border border-app-border px-2 py-0.5 text-[11px] font-normal tabular-nums text-tx-tertiary">
            {data?.total || 0} 条
          </span>
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={openCommentCenter}>
            <MessageSquareText size={15} className="mr-2" />
            评论管理
          </Button>
          <Button onClick={shareActiveNote}>
            <Plus size={15} className="mr-1.5" />
            新建分享
          </Button>
        </div>
      </header>

      {/* 工具行：搜索 + 快捷 chips + 排序，与原型同一行 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-app-border px-4 text-xs text-tx-secondary">
        <label className="relative block w-[210px] shrink-0">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2 text-tx-tertiary" />
          <Input
            aria-label="搜索分享"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="搜索标题 / 文件名 / 链接"
            className="h-8 pl-8 text-xs"
          />
        </label>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {SHARE_QUICK_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              aria-pressed={quick === chip.key}
              onClick={() => setShareCenterUi({ quick: chip.key === "all" || quick === chip.key ? "all" : chip.key })}
              className={cn(
                "rounded-full border px-2.5 py-[3px] text-[11px] transition-colors",
                quick === chip.key
                  ? "border-[#b9cffc] bg-[#e8efff] text-accent-primary dark:border-accent-primary/40 dark:bg-accent-primary/15"
                  : "border-app-border bg-app-bg text-tx-secondary hover:bg-app-hover",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <div ref={sortMenuRef} className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={sortMenuOpen}
            onClick={() => setSortMenuOpen((value) => !value)}
            className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-bg px-2 py-1 text-[11px] text-tx-secondary transition-colors hover:bg-app-hover"
          >
            排序：<span className="font-medium text-tx-primary">{SHARE_SORT_OPTIONS.find((option) => option.value === sort)?.label}</span>
            <ChevronDown size={12} />
          </button>
          {sortMenuOpen && (
            <div role="listbox" className="absolute right-0 z-40 mt-1 w-32 overflow-hidden rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl">
              {SHARE_SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={sort === option.value}
                  onClick={() => { setShareCenterUi({ sort: option.value }); setSortMenuOpen(false); }}
                  className={cn(
                    "flex w-full items-center px-2.5 py-1 text-left text-[11px] hover:bg-app-hover",
                    sort === option.value ? "text-accent-primary" : "text-tx-secondary",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 批量条：蓝底横条常驻在表格上方（原型只展示「已选 N 项」这一种状态） */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[#cddffc] bg-[#eef4ff] px-4 py-1.5 text-xs text-tx-secondary dark:border-accent-primary/30 dark:bg-accent-primary/10">
          <span className="font-medium text-tx-primary">已选 {selected.size} 项</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void batchDisable()}>批量停用</Button>
            <Button size="sm" variant="outline" onClick={() => void batchExpire()}>批量设过期（30 天后）</Button>
            <Button size="sm" variant="outline" onClick={() => void batchCopy()}>批量复制全部链接</Button>
            <Button size="sm" variant="outline" className="text-rose-600 dark:text-rose-300" onClick={() => void batchDelete()}>批量删除</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())}>取消</Button>
          </div>
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-app-bg">
        {loading ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-tx-secondary">
            <Loader2 size={18} className="mr-2 animate-spin" />正在加载分享链接…
          </div>
        ) : error ? (
          <div className="m-4 flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-rose-500/30 bg-rose-500/5 px-6 text-center">
            <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>
            <Button className="mt-3" variant="outline" onClick={() => void load()}>重试</Button>
          </div>
        ) : items.length === 0 ? (
          <div className="m-4 flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-app-border bg-app-surface px-6 text-center">
            <Link2 size={30} className="text-tx-tertiary" />
            <h2 className="mt-3 font-medium text-tx-primary">还没有符合条件的分享链接</h2>
            <p className="mt-1 max-w-md text-sm text-tx-secondary">
              笔记、附件、目录三条线都收在这里了。若确实分享过文件却看不到，试着清掉左侧筛选。
            </p>
          </div>
        ) : (
          <>
            <table className="w-full min-w-[880px] table-fixed text-left text-sm">
              <thead className="sticky top-0 z-10 bg-app-surface text-[11.5px] font-normal text-tx-secondary shadow-[inset_0_-1px_0_var(--app-border)]">
                <tr>
                  <th className="w-9 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="全选本页"
                      checked={selectableItems.length > 0 && selectableItems.every((item) => selected.has(itemKey(item)))}
                      onChange={(event) => setSelected((current) => {
                        const next = new Map(current);
                        if (event.target.checked) {
                          for (const item of selectableItems) next.set(itemKey(item), item);
                        } else {
                          for (const item of selectableItems) next.delete(itemKey(item));
                        }
                        return next;
                      })}
                    />
                  </th>
                  <th className="w-[26%] px-2.5 py-2.5">对象 / 链接</th>
                  <th className="w-[9%] px-2.5 py-2.5">状态</th>
                  <th className="w-[17%] px-2.5 py-2.5">谁可以访问</th>
                  <th className="w-[13%] px-2.5 py-2.5">访问</th>
                  <th className="w-[12%] px-2.5 py-2.5">有效期</th>
                  <th className="w-[210px] px-2.5 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const Icon = OBJECT_ICONS[item.objectKind];
                  const checked = selected.has(itemKey(item));
                  const lastSeen = formatShareLastSeen(item.lastSeenAt);
                  return (
                    <tr
                      key={itemKey(item)}
                      onClick={() => setDetail(item)}
                      className={cn(
                        "cursor-pointer align-top border-t border-app-border/70 transition-colors hover:bg-app-hover/40",
                        checked && "bg-accent-primary/[0.05]",
                      )}
                    >
                      <td className="px-3 py-2.5" onClick={(event) => event.stopPropagation()}>
                        {item.channel === "attachment_bare" ? (
                          <span className="text-[11px] text-tx-tertiary" title="附件裸直链不是分享记录，不可批量处置">—</span>
                        ) : (
                          <input type="checkbox" aria-label={`选择 ${item.title || item.token}`} checked={checked} onChange={() => toggleSelected(item)} />
                        )}
                      </td>
                      <td className="px-2.5 py-2.5">
                        <div className="flex min-w-0 gap-2">
                          <span className="mt-0.5 shrink-0 rounded-md bg-app-hover p-1.5 text-tx-secondary"><Icon size={14} /></span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-tx-primary">
                              {item.title || "未命名"}
                              <span className="ml-1.5 rounded border border-app-border px-1 py-0.5 align-middle text-[10px] font-normal text-tx-tertiary">{shareObjectKindLabel(item.objectKind)}</span>
                            </p>
                            <p className="mt-0.5 truncate text-[11px] text-tx-tertiary">
                              {item.objectPath} · {formatShareDate(item.createdAt)} 创建
                              {item.channel === "file_share" || item.channel === "attachment_bare"
                                ? " · 稳定直链，不计数"
                                : ` · ${compactShareToken(item.token)}`}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-2.5 py-2.5"><StatusBadge status={item.status} channel={item.channel} /></td>
                      <td className="px-2.5 py-2.5">{renderAccess(item)}</td>
                      <td className="px-2.5 py-2.5">
                        <p className="tabular-nums text-tx-secondary">{formatShareViews(item)}</p>
                        <p className="mt-0.5 text-[11px] text-tx-tertiary">{item.viewCount === null ? "此通道不计数" : lastSeen ? `最近 ${lastSeen}` : "尚无访问记录"}</p>
                      </td>
                      <td className="px-2.5 py-2.5">
                        <p className={cn("text-xs", !item.expiresAt ? "text-tx-tertiary" : "text-tx-secondary")}>{formatShareExpiry(item.expiresAt)}</p>
                      </td>
                      <td className="px-2.5 py-2.5">{renderRowActions(item)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex flex-col gap-2 border-t border-app-border px-4 py-2.5 text-xs text-tx-tertiary sm:flex-row sm:items-center sm:justify-between">
              <span>
                共 {data?.total || 0} 条，第 {page} / {pageCount} 页
                {counts.risks.open_ended > 0 ? ` · 其中 ${counts.risks.open_ended} 条无密码且永久` : ""}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button>
                <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</Button>
              </div>
            </div>
          </>
        )}
      </div>

      {detail && (
        <ShareDetailDrawer
          item={detail}
          publicOrigin={publicOrigin}
          originOptions={originOptions}
          onClose={() => setDetail(null)}
          onRefresh={load}
          onRefreshItem={refreshDetail}
          onEditNote={(item) => { setDetail(null); setEditingNoteShare(item); }}
        />
      )}

      {editingNoteShare && (
        <ShareModal
          noteId={editingNoteShare.objectId}
          noteTitle={editingNoteShare.title || "未命名笔记"}
          initialShareId={editingNoteShare.id}
          onClose={() => { setEditingNoteShare(null); void load(true); }}
        />
      )}

      {creatingShare && (
        <ShareModal
          noteId={creatingShare.noteId}
          noteTitle={creatingShare.title}
          onClose={() => { setCreatingShare(null); void load(true); }}
        />
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
      <span className="shrink-0 text-tx-tertiary">{label}</span>
      <span className="min-w-0 text-right text-tx-secondary">{children}</span>
    </div>
  );
}

function ShareDetailDrawer({
  item,
  publicOrigin,
  originOptions,
  onClose,
  onRefresh,
  onRefreshItem,
  onEditNote,
}: {
  item: ShareCenterItem;
  publicOrigin: PublicWebOriginResolution;
  originOptions: PublicWebOriginOptions;
  onClose: () => void;
  onRefresh: (silent?: boolean) => Promise<void>;
  onRefreshItem: () => Promise<void>;
  onEditNote: (item: ShareCenterItem) => void;
}) {
  const url = buildPublicWebUrl(item.urlPath, originOptions);
  const lastSeen = formatShareLastSeen(item.lastSeenAt);
  const meta = shareStatusMeta(item.status);
  type VisitsState = { total: number; visits: ShareCenterVisit[]; supported: boolean; failedAttempts: number };
  const [visits, setVisits] = useState<VisitsState | null>(null);
  /** 抽屉自带密码 / 会话上限编辑：原型里这两行带「设置」「限制」内联入口。 */
  const canEditSettings = item.channel === "note_share" || item.channel === "attachment_share";
  const [passwordEditing, setPasswordEditing] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [maxViewsEditing, setMaxViewsEditing] = useState(false);
  const [maxViewsDraft, setMaxViewsDraft] = useState(item.maxViews === null ? "" : String(item.maxViews));
  const [savingSettings, setSavingSettings] = useState(false);

  // 访问明细只对笔记通道有会话表；其他通道后端回 supported=false，不编造数据。
  useEffect(() => {
    let cancelled = false;
    setVisits(null);
    shareCenterApi
      .visits(item.channel, item.id, 3)
      .then((result) => { if (!cancelled) setVisits(result); })
      .catch(() => { if (!cancelled) setVisits({ total: 0, visits: [], supported: false, failedAttempts: 0 }); });
    return () => { cancelled = true; };
  }, [item.channel, item.id]);

  /** 密码 / 会话上限在抽屉里就能改，不必再回各自的主界面。 */
  const patchSettings = async (
    patch: { password?: string | null; maxViews?: number | null },
    success: string,
  ) => {
    setSavingSettings(true);
    try {
      // 两边后端均支持 password / maxViews；password 变更会提 credentialVersion，旧访问令牌失效
      if (item.channel === "note_share") await api.updateShare(item.id, patch);
      else await attachmentShareApi.update(item.id, patch);
      toast.success(success);
      setPasswordEditing(false);
      setPasswordDraft("");
      setMaxViewsEditing(false);
      await onRefresh(true);
      await onRefreshItem();
    } catch (error: any) {
      toast.error(error?.message || "保存失败");
    } finally {
      setSavingSettings(false);
    }
  };

  const saveMaxViews = () => {
    const value = maxViewsDraft.trim() === "" ? null : Number(maxViewsDraft);
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      toast.error("会话上限需为正整数");
      return;
    }
    void patchSettings({ maxViews: value }, value === null ? "已取消会话上限" : `会话上限已设为 ${value}`);
  };

  const act = async (action: ShareCenterBatchAction, expiresAt?: string) => {
    try {
      const result = await shareCenterApi.batch(action, [{ channel: item.channel, id: item.id }], expiresAt);
      if (result.failed > 0) toast.warning("该分享已无权限或已被删除，请刷新列表");
      else toast.success(action === "expire" ? "有效期已更新" : action === "delete" ? "分享已删除" : "分享已停用");
      await onRefresh(true);
    } catch (error: any) {
      toast.error(error?.message || "操作失败");
    }
  };

  const resetViews = async () => {
    if (!item.isActive) return;
    try {
      if (item.channel === "note_share") await api.updateShare(item.id, { resetViews: true });
      else await attachmentShareApi.update(item.id, { resetViews: true });
      toast.success("访问次数已重置");
      await onRefresh(true);
    } catch (error: any) {
      toast.error(error?.message || "重置失败");
    }
  };

  const rotateToken = async () => {
    if (!await confirm({
      title: "轮换分享链接？",
      description: "旧链接和已签发的密码访问令牌会立即失效，访问次数同时清零。",
      danger: true,
    })) return;
    try {
      await api.updateShare(item.id, { rotateToken: true });
      toast.success("已生成新的分享链接");
      await onRefresh(true);
    } catch (error: any) {
      toast.error(error?.message || "轮换失败");
    }
  };

  const copyLink = async () => {
    const ok = await copyText(url);
    if (ok) toast.success("分享链接已复制");
    else toast.error("复制失败，请手动复制");
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(376px,100vw)] flex-col border-l border-app-border bg-app-elevated shadow-2xl">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-app-border px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-tx-primary">分享详情 · {item.title || "未命名分享"}</p>
        </div>
        <button type="button" aria-label="关闭分享详情" onClick={onClose} className="shrink-0 rounded-md p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary">
          <X size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {item.risks.includes("open_ended") && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/[0.07] px-3 py-2 text-xs leading-5 text-rose-700 dark:text-rose-300">
            🔓 <b>无密码 + 永久有效 + 无访问上限</b>：任何拿到链接的人都能反复访问。建议加密码，或改成 {SHARE_DEFAULT_EXPIRY_DAYS} 天过期（新建分享的默认值）。
          </p>
        )}
        {item.status === "orphan" && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
            原对象已删除或在回收站，建议直接停用 / 删除这条分享。
          </p>
        )}

        <section className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-tx-tertiary">分享链接</p>
          <code className="block break-all rounded-lg bg-app-hover/60 px-3 py-2 text-[11px] text-tx-secondary">{url}</code>
          {publicOrigin.risk !== "none" && (
            <p className="text-[11px] leading-4 text-amber-600 dark:text-amber-300">{getOriginRiskCopy(publicOrigin).message}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void copyLink()}><Copy size={13} className="mr-1.5" />复制</Button>
            <Button size="sm" variant="outline" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}><ExternalLink size={13} className="mr-1.5" />预览访客页</Button>
          </div>
        </section>

        <section className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-tx-tertiary">访问控制</p>
          <DetailRow label="状态"><span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px]", meta.className)}>{meta.label}</span></DetailRow>
          <DetailRow label="可见范围">{shareAccessLabel(item.access)}</DetailRow>
          <DetailRow label="权限">{sharePermissionLabel(item.permission)}</DetailRow>
          <DetailRow label="访问密码">
            {item.hasPassword ? (
              canEditSettings ? (
                <span className="inline-flex items-center gap-1.5">
                  已设置
                  <button
                    type="button"
                    disabled={savingSettings}
                    onClick={() => void patchSettings({ password: null }, "已取消访问密码")}
                    className="text-accent-primary underline-offset-4 hover:underline disabled:opacity-50"
                  >
                    清除
                  </button>
                </span>
              ) : "已设置"
            ) : canEditSettings ? (
              <button
                type="button"
                onClick={() => { setPasswordDraft(""); setPasswordEditing(true); }}
                className="text-accent-primary underline-offset-4 hover:underline"
              >
                未设置 · 设置
              </button>
            ) : (
              "未设置"
            )}
          </DetailRow>
          {passwordEditing && canEditSettings && (
            <div className="flex items-center gap-1.5 py-1">
              <Input
                type="password"
                autoFocus
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void patchSettings({ password: passwordDraft }, "访问密码已更新");
                  if (event.key === "Escape") setPasswordEditing(false);
                }}
                placeholder="4 位以上密码"
                className="h-7 min-w-0 flex-1 text-xs"
                aria-label="访问密码"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0"
                disabled={savingSettings || passwordDraft.trim().length < 4}
                onClick={() => void patchSettings({ password: passwordDraft }, "访问密码已更新")}
              >
                保存
              </Button>
              <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={() => setPasswordEditing(false)}>取消</Button>
            </div>
          )}
          <DetailRow label="有效期">{formatShareExpiry(item.expiresAt)}</DetailRow>
          <DetailRow label="会话上限">
            {item.maxViews === null ? (
              canEditSettings ? (
                <button
                  type="button"
                  onClick={() => { setMaxViewsDraft(""); setMaxViewsEditing(true); }}
                  className="text-accent-primary underline-offset-4 hover:underline"
                >
                  不限 · 限制
                </button>
              ) : "不限"
            ) : (
              <span className="inline-flex items-center gap-1.5">
                {item.maxViews}
                {canEditSettings && (
                  <>
                    <button
                      type="button"
                      onClick={() => { setMaxViewsDraft(String(item.maxViews)); setMaxViewsEditing(true); }}
                      className="text-accent-primary underline-offset-4 hover:underline"
                    >
                      修改
                    </button>
                    <button
                      type="button"
                      disabled={savingSettings}
                      onClick={() => void patchSettings({ maxViews: null }, "已取消会话上限")}
                      className="text-accent-primary underline-offset-4 hover:underline disabled:opacity-50"
                    >
                      取消
                    </button>
                  </>
                )}
              </span>
            )}
          </DetailRow>
          {maxViewsEditing && canEditSettings && (
            <div className="flex items-center gap-1.5 py-1">
              <Input
                type="number"
                min={1}
                autoFocus
                value={maxViewsDraft}
                onChange={(event) => setMaxViewsDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveMaxViews();
                  if (event.key === "Escape") setMaxViewsEditing(false);
                }}
                placeholder="留空 = 不限"
                className="h-7 min-w-0 flex-1 text-xs"
                aria-label="会话上限"
              />
              <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={savingSettings} onClick={saveMaxViews}>保存</Button>
              <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={() => setMaxViewsEditing(false)}>取消</Button>
            </div>
          )}
          <DetailRow label="原对象">{item.objectPath}</DetailRow>
          {item.capabilities && (
            <DetailRow label="开放能力">
              {[
                item.capabilities.download ? "下载" : null,
                item.capabilities.comment ? "评论" : null,
                item.capabilities.edit ? "编辑" : null,
                item.capabilities.reshare ? "二次分享" : null,
              ].filter(Boolean).join(" · ") || "仅浏览"}
            </DetailRow>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => void act("expire", shareExpiresInDays(SHARE_DEFAULT_EXPIRY_DAYS))}>设 {SHARE_DEFAULT_EXPIRY_DAYS} 天过期</Button>
            <Button size="sm" variant="outline" onClick={() => void act("expire", shareExpiresInDays(30))}>设 30 天过期</Button>
          </div>
          {item.channel === "note_share" ? (
            <button type="button" onClick={() => onEditNote(item)} className="mt-1 inline-flex items-center gap-1 text-xs text-accent-primary underline-offset-4 hover:underline">
              <Pencil size={12} /> 在分享对话框里改密码 / 权限 / 轮换链接
            </button>
          ) : (
            <p className="pt-1 text-[11px] leading-4 text-tx-tertiary">
              {item.channel === "attachment_share"
                ? "密码与会话上限在上面直接改；过期时间用上方按钮，停用与删除在危险操作里。"
                : item.channel === "notebook_invite"
                  ? "角色与使用次数上限在目录分享对话框里调整；撤销会同时移除经链接加入的协作者。"
                  : item.channel === "notebook_publication"
                    ? "访问方式与开放能力在目录分享对话框里调整。"
                    : "稳定直链由「复制内容时自动升级」产生，这里只能停用或删除。"}
            </p>
          )}
        </section>

        <section className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-tx-tertiary">
            访问记录{visits?.supported ? `（近 ${visits.visits.length} 条 / 共 ${visits.total} 个会话）` : ""}
          </p>
          <DetailRow label="访问量">{formatShareViews(item)}</DetailRow>
          <DetailRow label="最近访问">{lastSeen || (item.viewCount === null ? "此通道不计数" : "尚无")}</DetailRow>
          <DetailRow label="创建时间">{formatShareDate(item.createdAt)}</DetailRow>
          <DetailRow label="更新时间">{formatShareDate(item.updatedAt)}</DetailRow>
          {visits?.supported && visits.visits.length > 0 && (
            <ul className="mt-2 divide-y divide-app-border overflow-hidden rounded-lg border border-app-border">
              {visits.visits.map((visit) => (
                <li
                  key={`${visit.session}-${visit.lastSeenAt}`}
                  className="flex items-start justify-between gap-3 px-3 py-1.5 text-[11px]"
                >
                  <span className="shrink-0 text-tx-tertiary">{formatShareLastSeen(visit.lastSeenAt) || "—"}</span>
                  <span className="min-w-0 truncate text-right text-tx-secondary">
                    {describeUserAgent(visit.userAgent)}
                    {visit.ipPrefix ? ` · IP ${visit.ipPrefix}` : ""}
                    <span className="ml-1.5 text-tx-tertiary">#{visit.session}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {visits?.supported && visits.visits.length === 0 && (
            <p className="pt-1 text-[11px] text-tx-tertiary">访客打开链接后才会记录会话，目前还没有明细。</p>
          )}
          {visits && !visits.supported && (
            <p className="pt-1 text-[11px] text-tx-tertiary">该通道只提供累计次数，不提供逐次明细。</p>
          )}
          {/* 原型这一行在明细末尾：失败尝试次数（密码爆破会自动限频） */}
          <DetailRow label="失败尝试">
            <span className={visits && visits.failedAttempts > 0 ? "text-rose-600 dark:text-rose-300" : undefined}>
              {visits ? `${visits.failedAttempts} 次` : "—"}
            </span>
            <span className="text-tx-tertiary">（密码爆破会自动限频）</span>
          </DetailRow>
        </section>

        {item.channel !== "attachment_bare" && (
          <section className="space-y-2 border-t border-app-border pt-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-tx-tertiary">危险操作</p>
            <div className="flex flex-wrap gap-2">
              {item.channel === "note_share" && (
                <>
                  <Button size="sm" variant="outline" onClick={() => void rotateToken()}><RotateCcw size={13} className="mr-1.5" />轮换链接</Button>
                  <Button size="sm" variant="outline" disabled={item.viewCount === null || item.viewCount === 0} onClick={() => void resetViews()}>重置访问次数</Button>
                </>
              )}
              {item.channel === "attachment_share" && (
                <Button size="sm" variant="outline" disabled={item.viewCount === null || item.viewCount === 0} onClick={() => void resetViews()}>重置访问次数</Button>
              )}
              {item.channel !== "note_share" && (
                <Button size="sm" variant="outline" onClick={() => void act("disable")}><PowerOff size={13} className="mr-1.5" />停用</Button>
              )}
              <Button size="sm" variant="outline" className="text-rose-600 dark:text-rose-300" onClick={() => void act("delete")}><Trash2 size={13} className="mr-1.5" />删除分享</Button>
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
