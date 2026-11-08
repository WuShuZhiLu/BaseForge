/**
 * 远程文件 —— 文件管理里的「远程」来源视图（内核能力，非插件）。
 *
 * 布局：顶栏 / 工具条 / 面包屑 / 文件列表 / 右侧文本编辑器，全部与本地「文件」视图同一套
 * 节奏（h-12 顶栏带 32px 图标方块与状态徽章、h-10 工具条：搜索 + 分割线 + 统计 + 排序、
 * 列表带表头与复选框），这样两个来源切换时不会像换了个产品。
 *
 * 存储（源）不在这里切换，统一放侧栏「存储」分组（filesUi 的 remoteSourceId），
 * 与侧栏「来源」的选择模型一致；本面板只负责当前源的文件浏览与编辑。
 *
 * 所有远程操作走后端 /api/remote-files 代理：凭据只在服务端加密存储，前端永不见明文。
 * 支持源（按常用顺序）：WebDAV、SMB、百度网盘（直连，建议改用 OpenList + WebDAV）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { alert, confirm } from "@/components/ui/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MenuItem, MenuSurface } from "@/components/ui/menu";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  FileText,
  GitCompare,
  Folder,
  FolderPlus,
  Loader2,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Square,
  Trash2,
  X,
  ArrowDownUp,
  MoreHorizontal,
  Settings,
} from "lucide-react";

import { api, getCurrentWorkspace } from "@/lib/api";
import { navigateToAppPath } from "@/lib/appPathNavigation";
import { invalidateRemoteNoteLinks, setRemoteNoteLinksCache } from "@/lib/remoteNoteSync";
import RemoteLinkDialog, { rememberRemoteLinkNotebook, type RemoteLinkTarget } from "@/components/RemoteLinkDialog";
import { markdownToTiptapJSON, normalizeToMarkdown } from "@/lib/contentFormat";
import {
  FILE_REMOTE_SORT_OPTIONS,
  filterSortRemoteEntries,
  getFilesRemoteSort,
  getFilesRemoteSourceId,
  getFilesRemoteTime,
  getFilesRemoteTypes,
  getFilesUiVersion,
  setFilesUi,
  subscribeFilesUi,
  type FilesRemoteSortKey,
} from "@/features/files/filesUi";
import type { RemoteFileEntry, RemoteNoteLink, RemoteSourcePublic } from "@/types";

type SourceType = "webdav" | "baidu" | "smb";

/** 类型顺序按实际使用频率排；百度网盘直连不再开放新增，已配置的源仍可查看编辑 */
const SOURCE_TYPE_ORDER: SourceType[] = ["webdav", "smb"];

const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  webdav: "WebDAV",
  smb: "SMB",
  baidu: "百度网盘（直连）",
};

interface SourceDraft {
  id?: string;
  type: SourceType;
  name: string;
  baseUrl: string;
  username: string;
  /** WebDAV/SMB 密码；百度网盘源时忽略 */
  password: string;
  /** 百度网盘 access_token；WebDAV/SMB 源时忽略 */
  accessToken: string;
  /** SMB 主机（IP 或主机名），共享由「浏览共享」列出后选择，不手填 */
  smbHost: string;
  /** SMB 共享名（可多选：一个设备上文件分散在几个共享时不用配多遍） */
  smbShares: string[];
  /** SMB 域/工作组（可选） */
  domain: string;
  rootPath: string;
  /** 百度 OAuth：API Key */
  clientId: string;
  /** 百度 OAuth：Secret Key（仅表单内，保存时加密上传） */
  clientSecret: string;
  /** 百度 OAuth：refresh_token（换令牌后自动填入） */
  refreshToken: string;
  /** 百度 OAuth：access_token 过期时间（换令牌后自动填入） */
  tokenExpiresAt: string;
  /** 授权码输入（临时，不保存） */
  oauthCode: string;
}

const emptyDraft = (type: SourceType = "webdav"): SourceDraft => ({
  type,
  name: "",
  baseUrl: "",
  username: "",
  password: "",
  accessToken: "",
  domain: "",
  rootPath: "",
  smbHost: "",
  smbShares: [],
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  tokenExpiresAt: "",
  oauthCode: "",
});

const TEXT_EXTS = new Set([
  "md", "markdown", "txt", "json", "csv", "log", "yml", "yaml", "html", "htm", "css", "js", "ts",
  "py", "sh", "bat", "ini", "toml", "xml", "sql", "conf",
]);

/** 与后端 isProbablyTextFile 同口径：文本类扩展名才可导入为笔记 */
function isTextFileName(name: string): boolean {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ext === "" || TEXT_EXTS.has(ext);
}

/** PDF / Word（docx）原件可链接进知识库；doc 老格式与表格演示文稿暂不支持 */
function remoteDocKind(name: string): "pdf" | "docx" | null {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  return null;
}

/** 取远程二进制原件为 File（链接 PDF / Word 时用） */
async function fetchRemoteFileAsFile(sourceId: string, entry: RemoteFileEntry): Promise<File> {
  const res = await api.readRemoteFileBase64(sourceId, entry.path);
  const bytes = Uint8Array.from(atob(res.contentBase64), (ch) => ch.charCodeAt(0));
  return new File([bytes], entry.name, { type: "application/octet-stream" });
}

/** FNV-1a 32bit 字符串哈希（同步三态对比用，碰撞概率对单用户可接受） */
function fnvHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + s.length.toString(16);
}

/**
 * 目标知识库里已占用标题 → 加 (2)(3) 后缀。
 *
 * 远程目录里不同子目录可以有同名文件（README.md 到处都是），
 * 链接进同一个知识库后如果都叫「README」，靠标题就分不出谁是谁了。
 */
function uniqueNoteTitle(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} (${index})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base} (${Date.now().toString(36)})`;
}

function formatSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

const BS = String.fromCharCode(92);

/** 跳到知识库里的某条笔记（远程投影笔记的落点）：/kb/:space/:kb/notes/:noteId */
function navigateToNote(noteId: string, notebookId?: string): void {
  const space = getCurrentWorkspace();
  if (!notebookId) {
    navigateToAppPath(`/kb/${encodeURIComponent(space)}`);
    return;
  }
  // 链接映射刚变过：让编辑器侧的缓存失效，打开时才会按新基线判断三态
  invalidateRemoteNoteLinks();
  navigateToAppPath(
    `/kb/${encodeURIComponent(space)}/${encodeURIComponent(notebookId)}/notes/${encodeURIComponent(noteId)}`,
  );
}

/** 编辑已有源时把 UNC / smb:// 地址拆回主机与共享名（历史数据只有 baseUrl） */
function splitSmbBaseUrl(baseUrl: string): { host: string; share: string } {
  const raw = String(baseUrl || "").trim();
  const smb = raw.match(/^smb:\/\/([^/:?#]+)(?::\d+)?\/(.+)$/i);
  if (smb) return { host: smb[1], share: smb[2].split(/[\\/]/).filter(Boolean)[0] || "" };
  const parts = raw.replace(/^\\+/, "").split(/[\\/]/).filter(Boolean);
  return { host: parts[0] || "", share: parts[1] || "" };
}

/** 类型选择：项目统一下拉浮层（不用原生 select） */
function TypeSelect({ value, onChange }: { value: SourceType; onChange: (value: SourceType) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1 rounded-md border border-app-border bg-app-bg px-2 text-[11.5px] text-tx-secondary hover:bg-app-hover"
      >
        <span className="whitespace-nowrap font-medium text-tx-primary">{SOURCE_TYPE_LABEL[value]}</span>
        <ChevronDown size={12} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <MenuSurface className="absolute left-0 top-full z-50 mt-1 w-52">
            {SOURCE_TYPE_ORDER.map((type) => (
              <MenuItem
                key={type}
                label={SOURCE_TYPE_LABEL[type]}
                checked={type === value}
                onClick={() => { onChange(type); setOpen(false); }}
              />
            ))}
          </MenuSurface>
        </>
      ) : null}
    </div>
  );
}

function Overlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

/** ============ 源管理对话框 ============ */
function SourceManager(props: {
  sources: RemoteSourcePublic[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { sources, onClose, onChanged } = props;
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testState, setTestState] = useState<Record<string, string>>({});
  const [shareOptions, setShareOptions] = useState<Array<{ name: string; comment: string }>>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [browsed, setBrowsed] = useState(false);
  /** WebDAV 目录浏览：连接后逐层浏览，选根路径 */
  const [webdavBrowsed, setWebdavBrowsed] = useState(false);
  const [webdavBrowsePath, setWebdavBrowsePath] = useState("");
  const [webdavEntries, setWebdavEntries] = useState<RemoteFileEntry[]>([]);
  const [webdavLoading, setWebdavLoading] = useState(false);

  /**
   * 「连接」= SMB 添加流程的主按钮：一次动作同时完成连通性验证与共享枚举。
   * 失败时按网络不可达 / 认证失败 / 协议不兼容分类给出可操作的提示。
   */
  const browseShares = useCallback(async () => {
    if (!draft) return;
    const host = draft.smbHost.trim();
    if (!host) { setError("请先填写 SMB 主机地址（IP 或主机名）"); return; }
    setSharesLoading(true);
    setError("");
    setNotice("正在连接并枚举共享…");
    try {
      const res = await api.listSmbShares({
        host,
        username: draft.username.trim(),
        password: draft.password,
        domain: draft.domain.trim(),
        ...(draft.id ? { sourceId: draft.id } : {}),
      });
      setShareOptions(res.shares);
      setBrowsed(true);
      // 已保存过共享的源：新枚举结果里保留原选择；否则默认全选（用户说「一个或多个」，
      // 全选最省事，不想用的再点掉）
      setDraft((cur) => {
        if (!cur) return cur;
        const names = res.shares.map((share) => share.name);
        const kept = cur.smbShares.filter((name) => names.includes(name));
        return { ...cur, smbShares: kept.length ? kept : names };
      });
      setNotice(res.shares.length
        ? `连接成功，找到 ${res.shares.length} 个共享，点选要挂载的（可多选）`
        : "连接成功，但该账号下没有可见的磁盘共享（检查 NAS 共享设置与账号权限）");
    } catch (err: any) {
      setShareOptions([]);
      setBrowsed(false);
      setNotice("");
      setError(err?.message || "连接失败");
    } finally {
      setSharesLoading(false);
    }
  }, [draft]);

  /** WebDAV「连接」：验证连通性并列出指定路径的直接子项（逐层浏览选根路径） */
  const browseWebdav = useCallback(async (path: string) => {
    if (!draft) return;
    if (draft.type !== "webdav") return;
    if (!draft.baseUrl.trim() && !draft.id) { setError("请先填写服务器地址"); return; }
    setWebdavLoading(true);
    setError("");
    setNotice("正在连接并列出目录…");
    try {
      const res = await api.listWebdavDir({
        baseUrl: draft.baseUrl.trim(),
        username: draft.username.trim(),
        password: draft.password,
        path,
        ...(draft.id ? { sourceId: draft.id } : {}),
      });
      setWebdavEntries(res.entries);
      setWebdavBrowsePath(res.path);
      setWebdavBrowsed(true);
      setNotice(res.entries.length
        ? "连接成功；双击进入子目录，或点「设为根路径」"
        : "连接成功，该目录为空");
    } catch (err: any) {
      setWebdavBrowsed(false);
      setWebdavEntries([]);
      setNotice("");
      setError(err?.message || "连接失败");
    } finally {
      setWebdavLoading(false);
    }
  }, [draft]);

  const browseWebdavParent = useCallback(() => {
    if (!webdavBrowsePath) return;
    const parts = webdavBrowsePath.split("/").filter(Boolean);
    parts.pop();
    void browseWebdav(parts.join("/"));
  }, [webdavBrowsePath, browseWebdav]);

  const toggleShare = useCallback((name: string) => {
    setDraft((cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        smbShares: cur.smbShares.includes(name)
          ? cur.smbShares.filter((item) => item !== name)
          : [...cur.smbShares, name],
      };
    });
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setError("请填写名称"); return; }
    if (draft.type === "smb" && (draft.smbShares.length === 0 || !draft.smbHost.trim())) {
      setError("请点「浏览共享」并至少选择一个共享");
      return;
    }
    if (draft.type === "webdav" && !/^https?:\/\//i.test(draft.baseUrl.trim())) {
      setError("WebDAV 地址需以 http(s):// 开头，如 https://nas.local:5006");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.saveRemoteFileSource({
        id: draft.id,
        type: draft.type,
        name: draft.name.trim(),
        baseUrl: draft.type === "smb" ? "" : draft.baseUrl.trim(),
        // SMB 只传主机 + 共享列表，由后端决定落库形态（单共享沿用历史 UNC）
        ...(draft.type === "smb" ? { host: draft.smbHost.trim(), shares: draft.smbShares } : {}),
        username: draft.username,
        rootPath: draft.rootPath,
        ...(draft.domain ? { domain: draft.domain } : {}),
        ...(draft.password ? { password: draft.password } : {}),
        ...(draft.accessToken ? { accessToken: draft.accessToken } : {}),
        ...(draft.clientId ? { clientId: draft.clientId } : {}),
        ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
        ...(draft.refreshToken ? { refreshToken: draft.refreshToken } : {}),
        ...(draft.tokenExpiresAt ? { tokenExpiresAt: draft.tokenExpiresAt } : {}),
      });
      setDraft(null);
      setNotice("");
      onChanged();
    } catch (err: any) {
      setError(err?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  }, [draft, onChanged]);

  /** 百度 OAuth：打开授权页（oob，授权码由用户复制） */
  const openBaiduAuthorize = useCallback(async () => {
    if (!draft?.clientId) { setError("请先填写 API Key"); return; }
    try {
      const res = await api.getBaiduAuthorizeUrl(draft.clientId);
      window.open(res.url, "_blank");
    } catch (err: any) {
      setError(err?.message || "生成授权链接失败");
    }
  }, [draft]);

  /** 百度 OAuth：授权码换令牌，自动填入表单 */
  const exchangeBaiduCode = useCallback(async () => {
    if (!draft) return;
    if (!draft.oauthCode.trim() || !draft.clientId || !draft.clientSecret) {
      setError("换令牌需要：API Key + Secret Key + 授权码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api.exchangeBaiduToken(draft.oauthCode.trim(), draft.clientId, draft.clientSecret);
      setDraft({
        ...draft,
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        tokenExpiresAt: new Date(Date.now() + res.expiresIn * 1000).toISOString(),
        oauthCode: "",
      });
      setNotice("令牌已填入，请保存源");
    } catch (err: any) {
      setError(err?.message || "换取令牌失败");
    } finally {
      setBusy(false);
    }
  }, [draft]);

  const removeSource = useCallback(async (source: RemoteSourcePublic) => {
    const ok = await confirm({
      title: `删除远程源「${source.name}」？`,
      description: "仅删除本地配置，不影响远程文件。",
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await api.deleteRemoteFileSource(source.id);
      onChanged();
    } catch (err: any) {
      setError(err?.message || "删除失败");
    }
  }, [onChanged]);

  /** 源级健康检查：用已保存凭据探测连通性 */
  const testSource = useCallback(async (source: RemoteSourcePublic) => {
    setTestState((prev) => ({ ...prev, [source.id]: "测试中…" }));
    try {
      const res = await api.testRemoteSourceById(source.id);
      setTestState((prev) => ({ ...prev, [source.id]: `连通（${res.latencyMs}ms）` }));
    } catch (err: any) {
      setTestState((prev) => ({ ...prev, [source.id]: err?.message || "连接失败" }));
    }
  }, []);

  const editSource = useCallback((source: RemoteSourcePublic) => {
    const legacy = source.type === "smb" ? splitSmbBaseUrl(source.baseUrl) : { host: "", share: "" };
    setDraft({
      id: source.id,
      type: source.type,
      name: source.name,
      baseUrl: source.baseUrl,
      username: source.username,
      password: "",
      accessToken: "",
      domain: source.domain || "",
      rootPath: source.rootPath,
      smbHost: source.host || legacy.host,
      smbShares: source.shares && source.shares.length > 0 ? source.shares : (legacy.share ? [legacy.share] : []),
      clientId: source.clientId || "",
      clientSecret: "",
      refreshToken: "",
      tokenExpiresAt: "",
      oauthCode: "",
    });
    setShareOptions([]);
    setBrowsed(false);
    setNotice("");
    setError("");
  }, []);

  const sourceSubtitle = (source: RemoteSourcePublic) => {
    if (source.type === "baidu") return "百度网盘 · 需要开放平台应用凭据";
    if (source.type === "smb") {
      if (source.host) return `${source.host} · ${source.shares?.length ?? 0} 个共享`;
      return source.baseUrl;
    }
    return source.baseUrl;
  };

  return (
    <Overlay onClose={onClose}>
      <div className="flex max-h-[82vh] w-[600px] flex-col overflow-hidden rounded-xl border border-app-border bg-app-elevated shadow-2xl">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-app-border px-4">
          <Settings2 size={15} className="text-accent-primary" />
          <span className="text-[13px] font-semibold text-tx-primary">管理远程存储</span>
          <span className="flex-1" />
          <button
            type="button"
            className="rounded p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {sources.length === 0 && !draft ? (
            <p className="py-6 text-center text-xs text-tx-tertiary">尚未配置远程存储，点下方按钮新增。</p>
          ) : null}

          {sources.map((source) => (
            <div
              key={source.id}
              className="mb-1.5 flex items-center gap-2 rounded-lg border border-app-border px-3 py-2 hover:bg-app-hover/40"
            >
              <span className="shrink-0 rounded-md bg-app-hover px-1.5 py-0.5 text-[10px] font-medium text-tx-tertiary">
                {source.type === "smb" ? "SMB" : source.type === "webdav" ? "WebDAV" : "百度网盘"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-tx-primary">{source.name}</p>
                <p className="truncate text-[10.5px] text-tx-tertiary">
                  {sourceSubtitle(source)}
                  {source.rootPath ? ` · 根: ${source.rootPath}` : ""}
                </p>
                {source.credentialState === "unreadable" ? (
                  <p className="flex items-center gap-1 text-[10.5px] text-amber-600 dark:text-amber-400">
                    <AlertTriangle size={11} /> 凭据已失效（换机或恢复过备份），请重新输入密码
                  </p>
                ) : null}
                {testState[source.id] ? (
                  <p className="truncate text-[10.5px] text-emerald-500">{testState[source.id]}</p>
                ) : null}
              </div>
              <button
                type="button"
                title="测试连接"
                className="rounded p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
                onClick={() => void testSource(source)}
              >
                <RefreshCw size={13} />
              </button>
              <button
                type="button"
                title="编辑"
                className="rounded p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
                onClick={() => editSource(source)}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                title="删除"
                className="rounded p-1 text-tx-tertiary hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/30"
                onClick={() => void removeSource(source)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          {draft ? (
            <div className="mt-3 space-y-2 rounded-lg border border-app-border p-3">
              <div className="flex items-center gap-2">
                <TypeSelect
                  value={draft.type}
                  onChange={(type) => setDraft({ ...draft, type })}
                />
                <Input
                  className="h-7 min-w-0 flex-1 text-xs"
                  placeholder="名称，如：家里 NAS"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>

              {draft.type === "smb" ? (
                <>
                  <div className="flex gap-2">
                    <Input
                      className="h-7 min-w-0 flex-1 text-xs"
                      placeholder="主机地址，如 192.168.100.3"
                      value={draft.smbHost}
                      onChange={(e) => setDraft({ ...draft, smbHost: e.target.value })}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Input
                      className="h-7 min-w-0 flex-1 text-xs"
                      placeholder="用户名（可留空）"
                      value={draft.username}
                      onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                    />
                    <Input
                      type="password"
                      className="h-7 min-w-0 flex-1 text-xs"
                      placeholder={draft.id ? "密码（留空保持不变）" : "密码（可留空）"}
                      value={draft.password}
                      onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                    />
                    <Input
                      className="h-7 w-24 shrink-0 text-xs"
                      placeholder="域（可选）"
                      value={draft.domain}
                      onChange={(e) => setDraft({ ...draft, domain: e.target.value })}
                    />
                  </div>

                  {/* 共享多选：一个设备上的文件可能分散在几个共享，全都挂到一个源里 */}
                  {browsed && shareOptions.length > 0 ? (
                    <div className="rounded-md border border-app-border">
                      <div className="flex items-center justify-between border-b border-app-border px-2 py-1 text-[10.5px] text-tx-tertiary">
                        <span>共享（可多选）</span>
                        <span className="tabular-nums">已选 {draft.smbShares.length} / {shareOptions.length}</span>
                      </div>
                      <div className="max-h-40 overflow-y-auto p-1">
                        {shareOptions.map((share) => {
                          const checked = draft.smbShares.includes(share.name);
                          return (
                            <button
                              key={share.name}
                              type="button"
                              onClick={() => toggleShare(share.name)}
                              className={cn(
                                "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11.5px] hover:bg-app-hover",
                                checked ? "text-tx-primary" : "text-tx-secondary",
                              )}
                            >
                              {checked ? <CheckSquare size={13} className="shrink-0 text-accent-primary" /> : <Square size={13} className="shrink-0 text-tx-tertiary" />}
                              <span className="min-w-0 flex-1 truncate">{share.name}</span>
                              {share.comment ? <span className="max-w-[45%] truncate text-[10px] text-tx-tertiary">{share.comment}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  <details className="rounded border border-app-border px-2 py-1 text-[11px]">
                    <summary className="cursor-pointer select-none text-tx-tertiary">高级（共享内根路径）</summary>
                    <div className="mt-1.5">
                      <Input
                        className="h-7 w-full text-xs"
                        placeholder="共享内根路径（可选，如 /项目文档）"
                        value={draft.rootPath}
                        onChange={(e) => setDraft({ ...draft, rootPath: e.target.value })}
                      />
                    </div>
                  </details>
                  <p className="text-[10.5px] leading-4 text-tx-tertiary">
                    用户名与密码按需填写：公开共享（guest）两个都留空即可。点「连接」会验证地址可达性
                    与账号密码，成功后列出所有共享供选择。支持 SMB 2.1 ~ 3.1.1。
                  </p>
                </>
              ) : draft.type === "webdav" ? (
                <>
                  <Input
                    className="h-7 w-full text-xs"
                    placeholder="服务器地址，如 https://nas.local:5006/dav"
                    value={draft.baseUrl}
                    onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <Input
                      className="h-7 min-w-0 flex-1 text-xs"
                      placeholder="用户名（可留空）"
                      value={draft.username}
                      onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                    />
                    <Input
                      type="password"
                      className="h-7 min-w-0 flex-1 text-xs"
                      placeholder={draft.id ? "密码（留空保持不变）" : "密码（可留空）"}
                      value={draft.password}
                      onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                    />
                  </div>

                  {/* 目录浏览：连接后逐层浏览，选择根路径文件夹（也可手动填根路径） */}
                  {webdavBrowsed ? (
                    <div className="rounded-md border border-app-border">
                      <div className="flex items-center justify-between border-b border-app-border px-2 py-1 text-[10.5px] text-tx-tertiary">
                        <button
                          type="button"
                          className="truncate hover:text-accent-primary"
                          onClick={() => browseWebdavParent()}
                        >
                          {webdavBrowsePath || "根目录"}
                        </button>
                        <button
                          type="button"
                          className="shrink-0 text-accent-primary hover:underline"
                          onClick={() => setDraft({ ...draft, rootPath: webdavBrowsePath })}
                        >
                          设为根路径
                        </button>
                      </div>
                      <div className="max-h-40 overflow-y-auto p-1">
                        {webdavEntries.filter((entry) => entry.isFolder).length === 0 ? (
                          <p className="px-1.5 py-2 text-[11px] text-tx-tertiary">该目录下没有子文件夹</p>
                        ) : (
                          webdavEntries.filter((entry) => entry.isFolder).map((folder) => (
                            <button
                              key={folder.path}
                              type="button"
                              onClick={() => browseWebdav(folder.path)}
                              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11.5px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                            >
                              <Folder size={13} className="shrink-0 text-amber-500" />
                              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  ) : null}

                  <Input
                    className="h-7 w-full text-xs"
                    placeholder="根路径（可点上方目录选择，也可手动填）"
                    value={draft.rootPath}
                    onChange={(e) => setDraft({ ...draft, rootPath: e.target.value })}
                  />
                  <p className="text-[10.5px] leading-4 text-tx-tertiary">
                    百度网盘 / 夸克 / 115 / 阿里云盘等可以先用
                    <a className="mx-1 text-accent-primary underline-offset-2 hover:underline" href="https://github.com/OpenListTeam/OpenList" target="_blank" rel="noreferrer">OpenList</a>
                    挂载（自建实例自带 WebDAV：<span className="font-mono">http://主机:5244/dav/</span>），
                    这里填那个地址即可——一个协议覆盖所有网盘，不用逐个做授权。
                  </p>
                </>
              ) : (
                <>
                  <div className="rounded-md border border-amber-300/60 bg-amber-50 px-2 py-1.5 text-[10.5px] leading-4 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                    直连需要百度开放平台的应用凭据，且令牌会过期。更省事的方式：用
                    <a className="mx-1 underline underline-offset-2" href="https://github.com/OpenListTeam/OpenList" target="_blank" rel="noreferrer">OpenList</a>
                    挂载百度网盘，再用上面的 WebDAV 方式接入。
                  </div>
                  <Input
                    type="password"
                    className="h-7 w-full text-xs"
                    placeholder={draft.id ? "access_token（留空保持不变）" : "百度网盘 access_token"}
                    value={draft.accessToken}
                    onChange={(e) => setDraft({ ...draft, accessToken: e.target.value })}
                  />
                  <details className="rounded border border-app-border px-2 py-1 text-[11px]">
                    <summary className="cursor-pointer select-none text-tx-tertiary">应用凭据（可选：授权码换令牌 + 30 天自动续期）</summary>
                    <div className="mt-1.5 space-y-1.5">
                      <div className="flex gap-2">
                        <Input
                          className="h-7 min-w-0 flex-1 text-xs"
                          placeholder="API Key（client_id）"
                          value={draft.clientId}
                          onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
                        />
                        <Input
                          type="password"
                          className="h-7 min-w-0 flex-1 text-xs"
                          placeholder="Secret Key（留空保持不变）"
                          value={draft.clientSecret}
                          onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 shrink-0 px-2 text-[11px]"
                          disabled={busy || !draft.clientId}
                          onClick={() => void openBaiduAuthorize()}
                        >
                          打开授权页
                        </Button>
                        <Input
                          className="h-7 min-w-0 flex-1 text-xs"
                          placeholder="粘贴授权码（oob 页面显示）"
                          value={draft.oauthCode}
                          onChange={(e) => setDraft({ ...draft, oauthCode: e.target.value })}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 shrink-0 px-2 text-[11px]"
                          disabled={busy}
                          onClick={() => void exchangeBaiduCode()}
                        >
                          换令牌
                        </Button>
                      </div>
                    </div>
                  </details>
                </>
              )}

              {error ? <p className="break-words text-[11px] text-red-500">{error}</p> : null}
              {notice ? (
                <p className={cn("break-words text-[11px]", notice === "连接成功" ? "text-emerald-600" : "text-tx-tertiary")}>
                  {notice}
                </p>
              ) : null}

              <div className="flex items-center gap-2 pt-1">
                {draft.type === "smb" || draft.type === "webdav" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 whitespace-nowrap px-3 text-[11.5px]"
                    disabled={busy || sharesLoading || webdavLoading}
                    onClick={() => void (draft.type === "smb" ? browseShares() : browseWebdav(""))}
                  >
                    {sharesLoading || webdavLoading ? <Loader2 size={12} className="mr-1 animate-spin" /> : null}
                    {sharesLoading || webdavLoading ? "连接中…" : "连接"}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  className="h-7 shrink-0 whitespace-nowrap px-3 text-[11.5px]"
                  disabled={busy || !draft.name.trim() || (draft.type === "smb" && !browsed && draft.smbShares.length === 0) || (draft.type === "webdav" && !webdavBrowsed && !draft.id)}
                  onClick={() => void save()}
                >
                  保存
                </Button>
                <span className="min-w-0 flex-1" />
                <button
                  type="button"
                  className="shrink-0 whitespace-nowrap text-[11.5px] text-tx-tertiary hover:text-tx-secondary"
                  onClick={() => { setDraft(null); setError(""); setNotice(""); setShareOptions([]); setBrowsed(false); setWebdavBrowsed(false); setWebdavBrowsePath(""); setWebdavEntries([]); }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-app-border py-2 text-xs text-tx-tertiary hover:border-accent-primary hover:text-accent-primary"
              onClick={() => { setDraft(emptyDraft()); setShareOptions([]); setBrowsed(false); setWebdavBrowsed(false); setWebdavBrowsePath(""); setWebdavEntries([]); setError(""); setNotice(""); }}
            >
              <Plus size={13} /> 新增远程存储
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/** ============ 主区中心 ============ */
export default function RemoteFilesPanel() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<RemoteSourcePublic[]>([]);
  const [activeId, setActiveId] = useState("");
  const [managerOpen, setManagerOpen] = useState(false);

  const [cwd, setCwd] = useState("");
  const [remoteQuery, setRemoteQuery] = useState("");
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<RemoteFileEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** 多选模式：勾选框只在多选模式下显示（与本地文件视图同语义） */
  const [selectionMode, setSelectionMode] = useState(false);
  /** 「⋯ 更多」菜单（单行工具栏）：新建文件夹/刷新/管理存储 */
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  const [openPath, setOpenPath] = useState("");
  const [editorText, setEditorText] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [links, setLinks] = useState<RemoteNoteLink[]>([]);
  /** 待链接到知识库的远程文件（null = 弹窗关闭） */
  const [linkTargets, setLinkTargets] = useState<RemoteFileEntry[] | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [diffDlg, setDiffDlg] = useState<{
    entry: RemoteFileEntry;
    link: RemoteNoteLink;
    remoteContent: string;
    noteMarkdown: string;
    remoteChanged: boolean;
    noteChanged: boolean;
    busy: boolean;
  } | null>(null);

  const loadLinks = useCallback(() => {
    api.getRemoteNoteLinks()
      .then((r) => {
        setLinks(r.links);
        // 同步给 knowledge 侧的「远程来源」标记，连接/移动后图标能立刻更新
        setRemoteNoteLinksCache(r.links);
      })
      .catch(() => setLinks([]));
  }, []);

  const linkForEntry = useCallback(
    (entry: RemoteFileEntry) => (activeId ? links.find((l) => l.sourceId === activeId && l.remotePath === entry.path) : undefined),
    [activeId, links],
  );

  const flash = useCallback((msg: string) => {
    setActionMsg(msg);
    window.setTimeout(() => setActionMsg((cur) => (cur === msg ? "" : cur)), 4000);
  }, []);

  /**
   * 链接到知识库（第一步）：把待链接的文件放进弹窗，由用户选目标知识库。
   *
   * 语义：远程文件**不导入副本**，而是在选定的知识库里出现为一条普通笔记
   * （正文是远程内容的本地缓存），之后在编辑器里改完保存会自动写回远程
   * （见 lib/remoteNoteSync.ts）。已链接的文件走快捷路径直接跳笔记，不重复建。
   */
  const requestLink = useCallback((entries: RemoteFileEntry[]) => {
    const linkable = entries.filter((entry) => !entry.isFolder && (isTextFileName(entry.name) || remoteDocKind(entry.name)));
    if (linkable.length === 0) {
      flash("选中项里没有可链接的文件（支持文本 / PDF / Word；图片、压缩包等不能进知识库）");
      return;
    }
    const skipped = entries.length - linkable.length;
    if (skipped > 0) flash(`${skipped} 项不支持链接（图片、压缩包等），已跳过`);
    setLinkTargets(linkable);
  }, [flash]);

  /**
   * 链接到知识库（第二步）：批量落库。
   *
   * 三种情况分开计：
   *   - 未链接 → 读远程内容建笔记 + 建同步映射（笔记归属目标库，不是游离笔记）；
   *   - 已链接但笔记在别的库 → 移动过去，不重建（同步基线保留，笔记内容不丢）；
   *   - 已链接且就在目标库 → 跳过。
   * 单项操作完成后直接跳到那条笔记；批量则留在列表给出汇总。
   */
  const performLink = useCallback(async (target: RemoteLinkTarget) => {
    if (!activeId || !linkTargets || linkTargets.length === 0) return;
    setLinkBusy(true);
    rememberRemoteLinkNotebook(target.notebookId);

    // 目标库已有标题 → 重名加后缀（远程目录里 README.md 这类同名文件很常见）
    const usedTitles = new Set<string>();
    try {
      const existingNotes = await api.getNotes({ notebookId: target.notebookId });
      for (const note of existingNotes) {
        if (!note.isTrashed) usedTitles.add((note.title || "").trim());
      }
    } catch {
      /* 拿不到列表就当作空库，重名由用户自己整理 */
    }

    let created = 0;
    let moved = 0;
    let skipped = 0;
    let failed = 0;
    let lastNoteId = "";

    for (const entry of linkTargets) {
      const linked = links.find((item) => item.sourceId === activeId && item.remotePath === entry.path);
      try {
        if (linked) {
          const note = await api.getNote(linked.noteId);
          if (note.notebookId === target.notebookId) {
            skipped += 1;
            continue;
          }
          await api.updateNote(linked.noteId, { notebookId: target.notebookId });
          moved += 1;
          lastNoteId = linked.noteId;
          continue;
        }

        const docKind = remoteDocKind(entry.name);
        if (docKind === "pdf") {
          // PDF：建 contentFormat=pdf 的笔记 + 原件挂附件（同 importPdfIntoKnowledgeTree 流程）。
          // PDF 是批注型笔记不走 markdown 同步，映射基线用空串，仅保证「已链接」判定可用。
          const file = await fetchRemoteFileAsFile(activeId, entry);
          const baseTitle = entry.name.replace(/\.pdf$/i, "").trim() || "PDF 文档";
          const title = uniqueNoteTitle(baseTitle, usedTitles);
          usedTitles.add(title);
          const note = await api.createNote({ title, notebookId: target.notebookId, contentFormat: "pdf" });
          const attachment = await api.attachments.upload(note.id, file);
          await api.updateNote(note.id, {
            content: JSON.stringify({ attachmentId: attachment.id, annotations: [] }),
            contentText: "",
            version: note.version,
          });
          try {
            await api.linkRemoteNote({
              sourceId: activeId, remotePath: entry.path, noteId: note.id,
              title, baseRemoteHash: fnvHash(""), baseNoteHash: fnvHash(""),
            });
          } catch { /* 映射失败不影响笔记可用 */ }
          created += 1;
          lastNoteId = note.id;
          continue;
        }
        if (docKind === "docx") {
          // Word（docx）：复用完整 docx 导入管线（IR 优先 / mammoth 兜底，图片自动传附件）
          const file = await fetchRemoteFileAsFile(activeId, entry);
          const { importDocxAsNoteSafe } = await import("@/lib/docxImportService");
          const result = await importDocxAsNoteSafe({ file, notebookId: target.notebookId });
          try {
            await api.linkRemoteNote({
              sourceId: activeId, remotePath: entry.path, noteId: result.note.id,
              title: result.note.title || entry.name, baseRemoteHash: fnvHash(""), baseNoteHash: fnvHash(""),
            });
          } catch { /* 映射失败不影响笔记可用 */ }
          created += 1;
          lastNoteId = result.note.id;
          continue;
        }
        const res = await api.readRemoteFile(activeId, entry.path);
        const json = markdownToTiptapJSON(res.content);
        const baseTitle = entry.name.replace(/\.[^.]+$/, "") || "未命名";
        const title = uniqueNoteTitle(baseTitle, usedTitles);
        usedTitles.add(title);
        const note = await api.createNote({
          title,
          // 关键：不传 notebookId 会变成不属于任何知识库的游离笔记，知识树里根本看不到
          notebookId: target.notebookId,
          content: JSON.stringify(json),
          contentText: res.content.replace(/[#*`>\-|_\[\]()]/g, "").replace(/\n{2,}/g, "\n").trim(),
        });
        // 建立同步映射：基线 = 打开时远程内容与笔记 markdown
        const baseRemoteHash = fnvHash(res.content);
        const baseNoteHash = fnvHash(normalizeToMarkdown(JSON.stringify(json)) || "");
        try {
          await api.linkRemoteNote({
            sourceId: activeId,
            remotePath: entry.path,
            noteId: note.id,
            title,
            baseRemoteHash,
            baseNoteHash,
          });
        } catch {
          /* 映射失败不影响笔记可用，正文已经落在本地了 */
        }
        created += 1;
        lastNoteId = note.id;
      } catch {
        failed += 1;
      }
    }

    void loadLinks();
    invalidateRemoteNoteLinks();
    setLinkBusy(false);
    setLinkTargets(null);
    setSelected(new Set());

    const parts: string[] = [];
    if (created) parts.push(`新建 ${created} 条笔记`);
    if (moved) parts.push(`移动 ${moved} 条`);
    if (skipped) parts.push(`${skipped} 条已在目标库`);
    if (failed) parts.push(`${failed} 条失败`);
    flash(parts.length
      ? `已链接到「${target.notebookName}」：${parts.join("，")}`
      : "没有需要处理的文件");

    // 单项操作直接进笔记；批量留在列表，避免把用户从批量上下文里踢走
    if (linkTargets.length === 1 && lastNoteId) navigateToNote(lastNoteId, target.notebookId);
  }, [activeId, flash, linkTargets, links, loadLinks]);

  /** 远程文件 → 本地附件（走文件管理存储管线：holder note + hash 去重） */
  const saveToLocal = useCallback(async (entry: RemoteFileEntry) => {
    if (!activeId) return;
    try {
      const res = await api.uploadRemoteFileToLocal(activeId, entry.path, entry.name);
      flash(res.deduplicated
        ? `文件管理已存在相同内容：「${res.filename}」`
        : `已存入文件管理「${res.filename}」`);
    } catch (err: any) {
      flash(err?.message || "存入文件管理失败");
    }
  }, [activeId, flash]);

  const activeSource = sources.find((s) => s.id === activeId) || null;

  // 侧栏共享 store：类型 chips / 排序 / 时间 / 当前存储都由它驱动
  const filesUiVersion = useSyncExternalStore(subscribeFilesUi, getFilesUiVersion);
  void filesUiVersion;
  const remoteTypes = getFilesRemoteTypes();
  const remoteSort = getFilesRemoteSort();
  const storeSourceId = getFilesRemoteSourceId();
  // 文件夹始终置顶且不受类型过滤影响；类型/搜索/排序只作用于文件条目。
  const displayedEntries = filterSortRemoteEntries(entries, remoteQuery, remoteTypes, remoteSort, getFilesRemoteTime());

  const reloadSources = useCallback(async () => {
    try {
      const res = await api.getRemoteFileSources();
      setSources(res.sources);
      setActiveId((prev) => {
        if (prev && res.sources.some((s) => s.id === prev)) return prev;
        if (storeSourceId && res.sources.some((s) => s.id === storeSourceId)) return storeSourceId;
        return res.sources[0]?.id || "";
      });
    } catch {
      setSources([]);
    }
    // storeSourceId 只在首次解析时读取，之后由本面板回写，不应成为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主区确定当前存储后回写 store，让侧栏「存储」高亮跟上（首次自动选中第一个源）
  useEffect(() => {
    if (!activeId) return;
    if (!sources.some((source) => source.id === activeId)) return;
    if (activeId === getFilesRemoteSourceId()) return;
    setFilesUi({ remoteSourceId: activeId });
  }, [activeId, sources]);

  // 「⋯ 更多」菜单外部点击关闭
  useEffect(() => {
    if (!moreMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [moreMenuOpen]);

  // Esc 退出多选
  useEffect(() => {
    if (!selectionMode) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSelected(new Set()); setSelectionMode(false); }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [selectionMode]);

  useEffect(() => { void reloadSources(); }, [reloadSources]);

  // 侧栏「存储」切换 → 主区跟随（同一份 localStorage 状态）
  useEffect(() => {
    if (storeSourceId && storeSourceId !== activeId && sources.some((s) => s.id === storeSourceId)) {
      setActiveId(storeSourceId);
      setCwd("");
      setOpenPath("");
      setEditorText("");
      setSelected(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSourceId, sources]);

  useEffect(() => { loadLinks(); }, [loadLinks, activeId]);

  // 侧栏「存储」里的「＋ 添加存储」/「管理」广播这里打开配置对话框
  useEffect(() => {
    const open = () => setManagerOpen(true);
    window.addEventListener("nowen:remote-open-manager", open);
    return () => window.removeEventListener("nowen:remote-open-manager", open);
  }, []);

  const loadList = useCallback(async (sourceId: string, path: string) => {
    if (!sourceId) { setEntries([]); return; }
    setListLoading(true);
    setListError("");
    try {
      const res = await api.listRemoteFiles(sourceId, path);
      setEntries(res.entries);
    } catch (err: any) {
      setListError(err?.message || "加载目录失败");
      setEntries([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeId) void loadList(activeId, cwd);
  }, [activeId, cwd, loadList]);

  useEffect(() => { setSelected(new Set()); }, [activeId, cwd]);

  const openFile = useCallback(async (entry: RemoteFileEntry) => {
    if (!activeId) return;
    setOpenPath(entry.path);
    setEditorLoading(true);
    setDirty(false);
    setEditorText("");
    try {
      const res = await api.readRemoteFile(activeId, entry.path);
      setEditorText(res.content);
    } catch (err: any) {
      setEditorText("");
      void alert({ title: "读取远程文件失败", description: err?.message || "读取失败" });
      setOpenPath("");
    } finally {
      setEditorLoading(false);
    }
  }, [activeId]);

  const saveFile = useCallback(async () => {
    if (!activeId || !openPath) return;
    setSaving(true);
    try {
      await api.writeRemoteFile(activeId, openPath, editorText);
      setDirty(false);
      void loadList(activeId, cwd);
    } catch (err: any) {
      void alert({ title: "写回远程文件失败", description: err?.message || "写回失败" });
    } finally {
      setSaving(false);
    }
  }, [activeId, openPath, editorText, cwd, loadList]);

  /** 打开对比弹层：拉远程内容与笔记内容，计算三态 */
  const openDiff = useCallback(async (entry: RemoteFileEntry, link: RemoteNoteLink) => {
    if (!activeId) return;
    setDiffDlg({ entry, link, remoteContent: "", noteMarkdown: "", remoteChanged: false, noteChanged: false, busy: true });
    try {
      const [remote, note] = await Promise.all([
        api.readRemoteFile(activeId, entry.path),
        api.getNote(link.noteId),
      ]);
      // 加密笔记保护：信封内容不可 round-trip 对比，覆盖会破坏加密结构
      if (note.contentFormat && String(note.contentFormat).startsWith("encrypted-")) {
        flash("该笔记已启用加密，暂不支持远程同步对比");
        setDiffDlg(null);
        return;
      }
      const noteMarkdown = normalizeToMarkdown(note.content) || "";
      const remoteHash = fnvHash(remote.content);
      const noteHash = fnvHash(noteMarkdown);
      setDiffDlg({
        entry,
        link,
        remoteContent: remote.content,
        noteMarkdown,
        remoteChanged: remoteHash !== link.baseRemoteHash,
        noteChanged: noteHash !== link.baseNoteHash,
        busy: false,
      });
    } catch (err: any) {
      flash(err?.message || "对比失败");
      setDiffDlg(null);
    }
  }, [activeId, flash]);

  /** 远程 → 笔记（覆盖本地笔记内容） */
  const syncFromRemote = useCallback(async () => {
    if (!diffDlg || !activeId) return;
    setDiffDlg({ ...diffDlg, busy: true });
    try {
      const json = markdownToTiptapJSON(diffDlg.remoteContent);
      await api.updateNote(diffDlg.link.noteId, { content: JSON.stringify(json) });
      const baseNoteHash = fnvHash(normalizeToMarkdown(JSON.stringify(json)) || "");
      const res = await api.updateRemoteNoteLinkSync({
        sourceId: activeId,
        remotePath: diffDlg.entry.path,
        baseRemoteHash: fnvHash(diffDlg.remoteContent),
        baseNoteHash,
      });
      setLinks((prev) => prev.map((l) => (l.sourceId === activeId && l.remotePath === diffDlg.entry.path ? res.link : l)));
      setDiffDlg(null);
      flash(`已用远程内容覆盖笔记「${diffDlg.link.title || diffDlg.entry.name}」`);
    } catch (err: any) {
      flash(err?.message || "同步失败");
      setDiffDlg((d) => (d ? { ...d, busy: false } : d));
    }
  }, [diffDlg, activeId, flash]);

  /** 笔记 → 远程（覆盖远程文件） */
  const syncFromNote = useCallback(async () => {
    if (!diffDlg || !activeId) return;
    setDiffDlg({ ...diffDlg, busy: true });
    try {
      await api.writeRemoteFile(activeId, diffDlg.entry.path, diffDlg.noteMarkdown);
      const res = await api.updateRemoteNoteLinkSync({
        sourceId: activeId,
        remotePath: diffDlg.entry.path,
        baseRemoteHash: fnvHash(diffDlg.noteMarkdown),
        baseNoteHash: diffDlg.link.baseNoteHash,
      });
      setLinks((prev) => prev.map((l) => (l.sourceId === activeId && l.remotePath === diffDlg.entry.path ? res.link : l)));
      setDiffDlg(null);
      flash(`已把笔记「${diffDlg.link.title || diffDlg.entry.name}」写回远程`);
    } catch (err: any) {
      flash(err?.message || "同步失败");
      setDiffDlg((d) => (d ? { ...d, busy: false } : d));
    }
  }, [diffDlg, activeId, flash]);

  /** 解除链接映射 */
  const unlinkNote = useCallback(async (entry: RemoteFileEntry, link: RemoteNoteLink) => {
    if (!activeId) return;
    try {
      await api.deleteRemoteNoteLink(activeId, entry.path);
      setLinks((prev) => prev.filter((l) => !(l.sourceId === activeId && l.remotePath === entry.path)));
      flash("已解除与笔记的链接");
    } catch (err: any) {
      flash(err?.message || "解除链接失败");
    }
  }, [activeId, flash]);

  const createFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!activeId || !name) return;
    try {
      await api.mkdirRemoteFile(activeId, cwd ? `${cwd}/${name}` : name);
      setNewFolderOpen(false);
      setNewFolderName("");
      void loadList(activeId, cwd);
    } catch (err: any) {
      void alert({ title: "创建目录失败", description: err?.message || "创建目录失败" });
    }
  }, [activeId, cwd, newFolderName, loadList]);

  const removeEntry = useCallback(async (entry: RemoteFileEntry) => {
    if (!activeId) return;
    const ok = await confirm({
      title: `删除远程${entry.isFolder ? "目录" : "文件"}「${entry.name}」？`,
      description: "此操作不可撤销。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteRemoteFile(activeId, entry.path);
      if (openPath === entry.path || openPath.startsWith(`${entry.path}/`)) {
        setOpenPath("");
        setEditorText("");
        setDirty(false);
      }
      void loadList(activeId, cwd);
    } catch (err: any) {
      void alert({ title: "删除远程条目失败", description: err?.message || "删除失败" });
    }
  }, [activeId, cwd, openPath, loadList]);

  const submitRename = useCallback(async () => {
    const newName = renameValue.trim();
    if (!activeId || !renameTarget || !newName || newName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    try {
      await api.renameRemoteFile(activeId, renameTarget.path, newName);
      setRenameTarget(null);
      void loadList(activeId, cwd);
    } catch (err: any) {
      void alert({ title: "重命名失败", description: err?.message || "重命名失败" });
    }
  }, [activeId, renameTarget, renameValue, loadList]);

  /** Shift 连选锚点：上次点选条目在 displayedEntries 中的下标 */
  const lastSelectIndexRef = useRef(-1);
  const toggleSelect = useCallback((path: string, event?: { shiftKey?: boolean }) => {
    const index = displayedEntries.findIndex((entry) => entry.path === path);
    // Shift 连选：从上次点选到当前条目整段选中
    if (event?.shiftKey && lastSelectIndexRef.current >= 0) {
      const from = Math.min(lastSelectIndexRef.current, index);
      const to = Math.max(lastSelectIndexRef.current, index);
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = from; i <= to; i++) {
          if (displayedEntries[i]) next.add(displayedEntries[i].path);
        }
        return next;
      });
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    lastSelectIndexRef.current = index;
  }, [displayedEntries]);

  const selectedEntries = useMemo(
    () => displayedEntries.filter((entry) => selected.has(entry.path)),
    [displayedEntries, selected],
  );

  const handleBatchLocal = useCallback(async () => {
    if (!activeId || selectedEntries.length === 0) return;
    setBatchBusy(true);
    let ok = 0;
    for (const entry of selectedEntries) {
      if (entry.isFolder) continue;
      try {
        await api.uploadRemoteFileToLocal(activeId, entry.path, entry.name);
        ok += 1;
      } catch { /* 单个失败继续 */ }
    }
    setBatchBusy(false);
    setSelected(new Set());
    flash(`已存入文件管理 ${ok} 个文件`);
  }, [activeId, selectedEntries, flash]);

  const handleBatchDelete = useCallback(async () => {
    if (!activeId || selectedEntries.length === 0) return;
    const ok = await confirm({
      title: `删除选中的 ${selectedEntries.length} 项？`,
      description: "包含目录时其内容也会一并删除，此操作不可撤销。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    setBatchBusy(true);
    let done = 0;
    for (const entry of selectedEntries) {
      try {
        await api.deleteRemoteFile(activeId, entry.path);
        done += 1;
      } catch { /* 单个失败继续 */ }
    }
    setBatchBusy(false);
    setSelected(new Set());
    void loadList(activeId, cwd);
    flash(`已删除 ${done} 项`);
  }, [activeId, selectedEntries, cwd, loadList, flash]);

  const crumbs = cwd ? cwd.split("/") : [];
  const currentSortLabel = FILE_REMOTE_SORT_OPTIONS.find((option) => option.value === remoteSort)?.label ?? "名称 A→Z";
  const credentialBroken = activeSource?.credentialState === "unreadable";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏单行：标题+存储徽章+面包屑(左)；多选时右端为批量操作，否则为搜索/新建/排序/刷新/选择/配置 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-app-border bg-app-surface/40 px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
          <Cloud size={18} />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="whitespace-nowrap text-[15px] font-semibold text-tx-primary">远程文件</h2>
          <div
            className={cn(
              "hidden items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] sm:flex",
              credentialBroken
                ? "border-amber-300/60 text-amber-600 dark:border-amber-500/30 dark:text-amber-400"
                : "border-app-border text-tx-tertiary",
            )}
            title={credentialBroken ? "凭据已失效，请到「管理远程存储」重新输入密码" : activeSource?.name || "未选择存储"}
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", credentialBroken ? "bg-amber-500" : activeSource ? "bg-emerald-500" : "bg-tx-tertiary")} />
            <span className="max-w-[160px] truncate font-medium">{activeSource ? activeSource.name : "未配置存储"}</span>
          </div>
        </div>
        {/* 面包屑：仅在进入子目录后出现（根目录时存储徽章已表达位置） */}
        {crumbs.length > 0 ? (
          <div className="flex min-w-0 items-center">
            <ChevronRight size={12} className="shrink-0 text-app-border" />
            {crumbs.map((part, index) => {
              const isLast = index === crumbs.length - 1;
              return (
                <React.Fragment key={`${index}-${part}`}>
                  {index > 0 ? <ChevronRight size={12} className="shrink-0 text-app-border" /> : null}
                  <button
                    type="button"
                    className={cn(
                      "max-w-[160px] truncate rounded px-1.5 py-0.5 text-xs transition-colors hover:bg-app-hover hover:text-accent-primary",
                      isLast ? "font-semibold text-tx-primary" : "text-tx-secondary",
                    )}
                    onClick={() => { setCwd(crumbs.slice(0, index + 1).join("/")); setOpenPath(""); }}
                  >
                    {part}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        ) : null}
        {actionMsg ? <span className="max-w-[200px] truncate text-[11px] text-emerald-500">{actionMsg}</span> : null}
        <span className="flex-1" />
        <>
          <label className="relative block w-[210px] shrink-0">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-2 text-tx-tertiary" />
              <Input
                placeholder={t("common.search")}
                value={remoteQuery}
                onChange={(e) => setRemoteQuery(e.target.value)}
                className="h-[30px] pl-7 pr-7 text-[11.5px]"
              />
              {remoteQuery ? (
                <button
                  type="button"
                  className="absolute right-2 top-1.5 text-tx-tertiary hover:text-tx-primary"
                  onClick={() => setRemoteQuery("")}
                >
                  <X size={12} />
                </button>
              ) : null}
            </label>
            {newFolderOpen ? (
              <span className="flex shrink-0 items-center gap-1">
                <input
                  autoFocus
                  className="h-7 w-32 rounded-md border border-app-border bg-transparent px-1.5 text-xs"
                  placeholder="新文件夹名"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); if (e.key === "Escape") setNewFolderOpen(false); }}
                />
                <button type="button" className="text-xs text-accent-primary" onClick={() => void createFolder()}>确定</button>
                <button type="button" className="text-xs text-tx-tertiary" onClick={() => setNewFolderOpen(false)}>取消</button>
              </span>
            ) : null}
            <div className="relative shrink-0">
              <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={sortOpen}
                title={`排序：${currentSortLabel}`}
                onClick={() => setSortOpen((v) => !v)}
                className="inline-flex h-[30px] w-10 items-center justify-center rounded-md border border-app-border bg-app-bg p-0 text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
              >
                <ArrowDownUp size={13} />
              </button>
              {sortOpen ? (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
                  <MenuSurface className="absolute right-0 top-full z-50 mt-1 w-36">
                    {FILE_REMOTE_SORT_OPTIONS.map((option) => (
                      <MenuItem
                        key={option.value}
                        label={option.label}
                        checked={option.value === remoteSort}
                        onClick={() => { setFilesUi({ remoteSort: option.value as FilesRemoteSortKey }); setSortOpen(false); }}
                      />
                    ))}
                  </MenuSurface>
                </>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setSelectionMode((v) => !v); setSelected(new Set()); }}
              className="h-[30px] w-10 shrink-0 justify-center px-0"
              title={selectionMode ? "退出多选（Esc）" : "进入多选"}
            >
              {selectionMode ? <X size={14} /> : <CheckSquare size={14} />}
            </Button>
            {/* 更多：新建文件夹 / 刷新 / 管理存储 */}
            <div ref={moreMenuRef} className="relative shrink-0">
              <button
                type="button"
                title="更多操作"
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                onClick={() => setMoreMenuOpen((v) => !v)}
                className="inline-flex h-7 w-10 items-center justify-center rounded-md border border-app-border bg-app-bg text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
              >
                <MoreHorizontal size={14} />
              </button>
              {moreMenuOpen && (
                <div role="menu" className="absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl">
                  {newFolderOpen ? (
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <input
                        autoFocus
                        className="h-7 w-28 rounded-md border border-app-border bg-transparent px-1.5 text-xs"
                        placeholder="新文件夹名"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); if (e.key === "Escape") setNewFolderOpen(false); }}
                      />
                      <button type="button" className="text-xs text-accent-primary" onClick={() => void createFolder()}>确定</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                      onClick={() => { setNewFolderOpen(true); setNewFolderName(""); }}
                    >
                      <FolderPlus size={13} className="shrink-0" /> 新建文件夹
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                    onClick={() => { setMoreMenuOpen(false); activeId && void loadList(activeId, cwd); }}
                  >
                    <RefreshCw size={13} className="shrink-0" /> 刷新
                  </button>
                  <div className="my-1 h-px bg-app-border" />
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                    onClick={() => { setMoreMenuOpen(false); setManagerOpen(true); }}
                  >
                    <Settings size={13} className="shrink-0" /> 管理存储…
                  </button>
                </div>
              )}
            </div>
            <span className="hidden lg:block w-px h-4 bg-app-border shrink-0" />
            <Button size="sm" className="h-[30px] w-[98px] shrink-0 justify-center px-0" onClick={() => setManagerOpen(true)}>
              <Plus size={14} className="mr-1" /> 配置存储
            </Button>
          </>
      </div>

      {/* 批量操作栏：点击选择后出现 */}
      {selectionMode && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border bg-accent-primary/5 px-4 py-1.5">
          <span className="shrink-0 whitespace-nowrap text-xs text-tx-secondary">
            {t("common.selectedCount", { count: selected.size })}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            className="h-[30px] shrink-0 px-2.5 text-xs"
            onClick={() => setSelected(new Set(entries.filter((e) => !e.isFolder).map((e) => e.path)))}
          >
            {t("common.selectAll")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-[30px] shrink-0 px-2.5 text-xs"
            disabled={batchBusy || linkBusy}
            onClick={() => requestLink(selectedEntries)}
          >
            {t("common.linkToKnowledge")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-[30px] shrink-0 px-2.5 text-xs"
            disabled={batchBusy || linkBusy}
            onClick={() => void handleBatchLocal()}
          >
            {t("common.importToLocal")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-[30px] shrink-0 px-2.5 text-xs"
            onClick={() => setSelected(new Set())}
          >
            {t("common.clearSelection")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-[30px] shrink-0 px-2.5 text-xs text-accent-danger"
            disabled={batchBusy}
            onClick={() => void handleBatchDelete()}
          >
            {t("common.deleteSelected")}
          </Button>
        </div>
      )}

      {sources.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-tx-tertiary">
          <Cloud size={32} className="opacity-40" />
          <p>还没有远程存储（WebDAV / SMB / 百度网盘）</p>
          <Button size="sm" onClick={() => setManagerOpen(true)}>添加远程存储</Button>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1">
            {/* 文件浏览器 */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* 表头：列宽与行一致 */}
              <div className="flex h-7 shrink-0 items-center gap-2 border-b border-app-border px-4 text-[10.5px] text-tx-tertiary">
                <span className={cn("shrink-0", selectionMode ? "w-4" : "w-[13px]")} />
                <span className="min-w-0 flex-1">名称</span>
                <span className="w-16 shrink-0 text-right">大小</span>
                <span className="hidden w-36 shrink-0 text-right md:block">修改时间</span>
                <span className="w-[104px] shrink-0" />
              </div>

              {/* 条目列表 */}
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
                {listLoading ? (
                  <p className="py-8 text-center text-xs text-tx-tertiary">加载中…</p>
                ) : listError ? (
                  <p className="break-words px-4 py-8 text-center text-xs text-red-400">{listError}</p>
                ) : entries.length === 0 ? (
                  <p className="py-8 text-center text-xs text-tx-tertiary">空目录</p>
                ) : displayedEntries.length === 0 ? (
                  <p className="py-8 text-center text-xs text-tx-tertiary">没有匹配的远程文件</p>
                ) : (
                  displayedEntries.map((entry) => {
                    const checked = selected.has(entry.path);
                    const linked = linkForEntry(entry);
                    return (
                      <div
                        key={entry.path}
                        className={cn(
                          "group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-app-hover",
                          openPath === entry.path && "bg-app-hover",
                        )}
                      >
                        {selectionMode ? (
                          <button
                            type="button"
                            aria-label={checked ? "取消选择" : "选择"}
                            className="shrink-0 text-tx-tertiary hover:text-accent-primary"
                            onClick={(e) => toggleSelect(entry.path, e)}
                          >
                            {checked ? <CheckSquare size={13} className="text-accent-primary" /> : <Square size={13} />}
                          </button>
                        ) : (
                          <span className="w-[13px] shrink-0" />
                        )}
                        {entry.isFolder ? (
                          <Folder size={14} className="shrink-0 text-amber-500" />
                        ) : (
                          <FileText size={14} className="shrink-0 text-sky-500" />
                        )}
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left"
                          onClick={() => (entry.isFolder
                            ? (setCwd(entry.path), setOpenPath(""))
                            : void openFile(entry))}
                        >
                          {entry.name}
                          {linked ? <span className="ml-1 text-[10px] text-sky-400">已链接</span> : null}
                        </button>
                        <span className="w-16 shrink-0 text-right text-[10px] text-tx-tertiary">
                          {entry.isFolder ? "—" : formatSize(entry.size)}
                        </span>
                        <span className="hidden w-36 shrink-0 truncate text-right text-[10px] text-tx-tertiary md:block">
                          {formatTime(entry.modifiedAt)}
                        </span>
                        <span className="flex w-[104px] shrink-0 items-center justify-end opacity-0 transition-opacity group-hover:opacity-100">
                          {!entry.isFolder && linked ? (
                            <button
                              type="button"
                              title="与笔记对比 / 同步"
                              className="rounded p-1 text-sky-400 hover:text-sky-300"
                              onClick={() => void openDiff(entry, linked)}
                            >
                              <GitCompare size={12} />
                            </button>
                          ) : null}
                          {!entry.isFolder ? (
                            <button
                              type="button"
                              title={linked
                                ? `在知识库打开「${linked.title}」`
                                : isTextFileName(entry.name)
                                  ? "链接到知识库（文本可直接读写，PDF / Word 转为笔记）"
                                  : "仅文本 / PDF / Word（docx）可链接到知识库"}
                              className={cn(
                                "rounded p-1 hover:text-accent-primary disabled:opacity-40",
                                linked ? "text-sky-400" : "text-tx-tertiary",
                              )}
                              disabled={!linked && !isTextFileName(entry.name) && !remoteDocKind(entry.name)}
                              onClick={() => {
                                if (linked) {
                                  // 跳笔记必须带容器的知识库 id，否则只会落到 /kb/:space 列表页
                                  void api.getNote(linked.noteId)
                                    .then((note) => navigateToNote(linked.noteId, note.notebookId || undefined))
                                    .catch(() => flash("这条笔记已不在知识库里"));
                                  return;
                                }
                                requestLink([entry]);
                              }}
                            >
                              <NotebookPen size={12} />
                            </button>
                          ) : null}
                          {!entry.isFolder ? (
                            <button
                              type="button"
                              title="存到文件管理"
                              className="rounded p-1 text-tx-tertiary hover:text-accent-primary"
                              onClick={() => void saveToLocal(entry)}
                            >
                              <Download size={12} />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            title="重命名"
                            className="rounded p-1 text-tx-tertiary hover:text-accent-primary"
                            onClick={() => { setRenameTarget(entry); setRenameValue(entry.name); }}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            title="删除"
                            className="rounded p-1 text-tx-tertiary hover:text-red-500"
                            onClick={() => void removeEntry(entry)}
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* 编辑器：打开文本文件才出现，关闭按钮或清空 openPath 后整个面板收起 */}
            {openPath ? (
              <div className="flex min-h-0 w-[42%] shrink-0 flex-col border-l border-app-border">
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-app-border px-3 text-xs">
                  <FileText size={13} className="shrink-0 text-sky-500" />
                  <span className="min-w-0 flex-1 truncate text-tx-primary">{openPath}</span>
                  {dirty ? <span className="shrink-0 text-[10px] text-amber-500">未保存</span> : null}
                  <Button
                    size="sm"
                    className="h-7 shrink-0 px-2 text-[11px]"
                    disabled={saving || !dirty}
                    onClick={() => void saveFile()}
                  >
                    <Save size={11} className="mr-1" /> {saving ? "保存中…" : "写回远程"}
                  </Button>
                  <button
                    type="button"
                    title="关闭"
                    className="shrink-0 rounded p-1 text-tx-tertiary hover:text-tx-secondary"
                    onClick={() => { setOpenPath(""); setEditorText(""); setDirty(false); }}
                  >
                    <X size={13} />
                  </button>
                </div>
                {editorLoading ? (
                  <p className="flex-1 py-8 text-center text-xs text-tx-tertiary">读取中…</p>
                ) : (
                  <textarea
                    className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                    spellCheck={false}
                    value={editorText}
                    onChange={(e) => { setEditorText(e.target.value); setDirty(true); }}
                  />
                )}
              </div>
            ) : null}
          </div>
        </>
      )}

      {diffDlg ? (
        <Overlay onClose={() => setDiffDlg(null)}>
          <div className="w-[430px] rounded-xl border border-app-border bg-app-elevated p-4 shadow-2xl">
            <p className="text-xs font-semibold text-tx-primary">
              同步：{diffDlg.entry.name} ↔ 笔记
            </p>
            <div className="mt-2 space-y-1 text-[11px] leading-5 text-tx-tertiary">
              <p>远程：{diffDlg.remoteChanged ? "已修改" : "未变化"}</p>
              <p>笔记：{diffDlg.noteChanged ? "已修改" : "未变化"}</p>
              <p>
                状态：
                {diffDlg.remoteChanged && diffDlg.noteChanged
                  ? "双方都有修改，请选择覆盖方向"
                  : diffDlg.remoteChanged
                    ? "远程有更新"
                    : diffDlg.noteChanged
                      ? "笔记有更新"
                      : "内容一致"}
                （上次同步 {new Date(diffDlg.link.syncedAt).toLocaleString()}）
              </p>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              {diffDlg.remoteChanged ? (
                <Button size="sm" className="h-7 px-3 text-[11.5px]" disabled={diffDlg.busy} onClick={() => void syncFromRemote()}>
                  远程 → 笔记
                </Button>
              ) : null}
              {diffDlg.noteChanged ? (
                <Button size="sm" variant="outline" className="h-7 px-3 text-[11.5px]" disabled={diffDlg.busy} onClick={() => void syncFromNote()}>
                  笔记 → 远程
                </Button>
              ) : null}
              <button
                type="button"
                disabled={diffDlg.busy}
                className="text-[11px] text-tx-tertiary hover:text-red-500"
                onClick={() => { void unlinkNote(diffDlg.entry, diffDlg.link); setDiffDlg(null); }}
              >
                解除链接
              </button>
              <Button size="sm" variant="outline" className="h-7 px-3 text-[11.5px]" disabled={diffDlg.busy} onClick={() => setDiffDlg(null)}>
                关闭
              </Button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {renameTarget ? (
        <Overlay onClose={() => setRenameTarget(null)}>
          <div className="w-80 rounded-xl border border-app-border bg-app-elevated p-4 shadow-2xl">
            <p className="mb-2 text-xs font-semibold">重命名</p>
            <input
              autoFocus
              className="h-8 w-full rounded border border-app-border bg-transparent px-2 text-xs"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submitRename(); if (e.key === "Escape") setRenameTarget(null); }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="outline" className="h-7 px-3 text-[11.5px]" onClick={() => setRenameTarget(null)}>
                取消
              </Button>
              <Button size="sm" className="h-7 px-3 text-[11.5px]" onClick={() => void submitRename()}>
                确定
              </Button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {managerOpen ? (
        <SourceManager
          sources={sources}
          onClose={() => setManagerOpen(false)}
          onChanged={() => {
            void reloadSources();
            // 侧栏「存储」列表读的是自己的快照，广播让它跟着重载
            window.dispatchEvent(new Event("nowen:remote-sources-changed"));
          }}
        />
      ) : null}

      <RemoteLinkDialog
        open={linkTargets !== null}
        count={linkTargets?.length ?? 0}
        busy={linkBusy}
        onClose={() => { if (!linkBusy) setLinkTargets(null); }}
        onConfirm={(target) => { void performLink(target); }}
      />
    </div>
  );
}
