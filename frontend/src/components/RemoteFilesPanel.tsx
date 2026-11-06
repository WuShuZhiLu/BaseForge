/**
 * 远程文件 —— 文件管理里的「远程」来源视图（内核能力，非插件）。
 *
 * 布局：左列源列表 / 中列文件浏览器（面包屑 + 目录导航 + 重命名/删除）/ 右列文本编辑器。
 * 所有远程操作走后端 /api/remote-files 代理：凭据只在服务端加密存储，前端永不见明文。
 * 支持源：WebDAV、SMB、百度网盘。
 */
import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { alert, confirm } from "@/components/ui/confirm";
import { MenuItem, MenuSurface } from "@/components/ui/menu";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  FileText,
  GitCompare,
  Folder,
  FolderPlus,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { markdownToTiptapJSON, normalizeToMarkdown } from "@/lib/contentFormat";
import { filterSortRemoteEntries, getFilesRemoteSort, getFilesRemoteTime, getFilesRemoteTypes, getFilesUiVersion, subscribeFilesUi } from "@/features/files/filesUi";
import type { RemoteFileEntry, RemoteNoteLink, RemoteSourcePublic } from "@/types";

type SourceType = "webdav" | "baidu" | "smb";

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
  /** SMB 主机（IP 或主机名），共享由「获取共享」列出后选择，不手填 */
  smbHost: string;
  /** SMB 共享名，来自服务端枚举 */
  smbShare: string;
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

const emptyDraft = (): SourceDraft => ({
  type: "webdav",
  name: "",
  baseUrl: "",
  username: "",
  password: "",
  accessToken: "",
  domain: "",
  rootPath: "",
  smbHost: "",
  smbShare: "",
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

/** FNV-1a 32bit 字符串哈希（同步三态对比用，碰撞概率对单用户可接受） */
function fnvHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + s.length.toString(16);
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

/** SMB 主机 + 共享名 → 后端仍使用的 UNC 地址（数据模型不变） */
function composeSmbBaseUrl(host: string, share: string): string {
  const bs = String.fromCharCode(92);
  const h = host.trim().replace(/^smb:\/\//i, "").replace(/^\\+/, "").split(/[\\/:?#]/)[0];
  const s = share.trim().replace(/^\\+/, "").split(/[\\/]/).filter(Boolean).join(bs);
  return h && s ? `${bs}${bs}${h}${bs}${s}` : "";
}

/** 编辑已有源时把 UNC / smb:// 地址拆回主机与共享名 */
function splitSmbBaseUrl(baseUrl: string): { host: string; share: string } {
  const raw = String(baseUrl || "").trim();
  const smb = raw.match(/^smb:\/\/([^/:?#]+)(?::\d+)?\/(.+)$/i);
  if (smb) return { host: smb[1], share: smb[2].split(/[\\/]/).filter(Boolean)[0] || "" };
  const parts = raw.replace(/^\\+/, "").split(/[\\/]/).filter(Boolean);
  return { host: parts[0] || "", share: parts[1] || "" };
}

/** 共享选择：复用项目统一的下拉浮层样式，不使用原生 select */
function ShareSelect(props: {
  value: string;
  options: Array<{ name: string; comment: string }>;
  onChange: (value: string) => void;
}) {
  const { value, options, onChange } = props;
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.name === value);
  return (
    <div className="relative w-full">
      <button
        type="button"
        disabled={options.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-1.5 rounded border border-app-border bg-transparent px-2 text-xs text-tx-primary hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {current?.name || (options.length ? "选择共享" : value || "请先点「获取共享」")}
        </span>
        <ChevronDown size={12} className={`shrink-0 text-tx-tertiary transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <MenuSurface className="absolute left-0 top-full z-50 mt-1 max-h-56 w-full min-w-[160px] overflow-y-auto">
            {options.map((option) => (
              <MenuItem
                key={option.name}
                label={option.comment ? `${option.name} · ${option.comment}` : option.name}
                checked={option.name === value}
                onClick={() => { onChange(option.name); setOpen(false); }}
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
  const [testResult, setTestResult] = useState("");
  const [testState, setTestState] = useState<Record<string, string>>({});
  const [shareOptions, setShareOptions] = useState<Array<{ name: string; comment: string }>>([]);
  const [sharesLoading, setSharesLoading] = useState(false);

  /** 用填写的主机与凭据向后端枚举共享；列表不落库，可随时重新获取 */
  const loadShares = useCallback(async () => {
    if (!draft) return;
    if (!draft.smbHost.trim()) { setTestResult("请先填写 SMB 主机地址"); return; }
    setSharesLoading(true);
    setTestResult("正在获取共享…");
    try {
      const res = await api.listSmbShares({
        host: draft.smbHost.trim(),
        username: draft.username.trim(),
        password: draft.password,
        domain: draft.domain.trim(),
        ...(draft.id ? { sourceId: draft.id } : {}),
      });
      setShareOptions(res.shares);
      setTestResult(res.shares.length
        ? `找到 ${res.shares.length} 个共享，请选择`
        : "未发现可用共享（检查账号权限或 NAS 共享设置）");
    } catch (err: any) {
      setShareOptions([]);
      setTestResult(err?.message || "获取共享失败");
    } finally {
      setSharesLoading(false);
    }
  }, [draft]);

  const save = useCallback(async () => {
    if (!draft) return;
    const baseUrl = draft.type === "smb"
      ? composeSmbBaseUrl(draft.smbHost, draft.smbShare)
      : draft.baseUrl;
    if (draft.type === "smb" && !baseUrl) {
      setError("请先点「获取共享」并选择要使用的共享");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.saveRemoteFileSource({
        id: draft.id,
        type: draft.type,
        name: draft.name,
        baseUrl,
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
      onChanged();
    } catch (err: any) {
      setError(err?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  }, [draft, onChanged]);

  const testConnection = useCallback(async () => {
    if (!draft) return;
    const baseUrl = draft.type === "smb"
      ? composeSmbBaseUrl(draft.smbHost, draft.smbShare)
      : draft.baseUrl;
    if (draft.type === "smb" && !baseUrl) {
      setTestResult("请先点「获取共享」并选择要使用的共享");
      return;
    }
    setTestResult("测试中…");
    try {
      await api.testRemoteFileSource({
        type: draft.type,
        baseUrl,
        username: draft.username,
        password: draft.password,
        accessToken: draft.accessToken,
        domain: draft.domain,
        rootPath: draft.rootPath,
      });
      setTestResult("连接成功");
    } catch (err: any) {
      setTestResult(err?.message || "连接失败");
    }
  }, [draft]);

  /** 百度 OAuth：打开授权页（oob，授权码由用户复制） */
  const openBaiduAuthorize = useCallback(async () => {
    if (!draft?.clientId) { setTestResult("请先填写 API Key"); return; }
    try {
      const res = await api.getBaiduAuthorizeUrl(draft.clientId);
      window.open(res.url, "_blank");
    } catch (err: any) {
      setTestResult(err?.message || "生成授权链接失败");
    }
  }, [draft]);

  /** 百度 OAuth：授权码换令牌，自动填入表单 */
  const exchangeBaiduCode = useCallback(async () => {
    if (!draft) return;
    if (!draft.oauthCode.trim() || !draft.clientId || !draft.clientSecret) {
      setTestResult("换令牌需要：API Key + Secret Key + 授权码");
      return;
    }
    setBusy(true);
    try {
      const res = await api.exchangeBaiduToken(draft.oauthCode.trim(), draft.clientId, draft.clientSecret);
      setDraft({
        ...draft,
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        tokenExpiresAt: new Date(Date.now() + res.expiresIn * 1000).toISOString(),
        oauthCode: "",
      });
      setTestResult("令牌已填入，请保存源");
    } catch (err: any) {
      setTestResult(err?.message || "换取令牌失败");
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
    const smb = source.type === "smb" ? splitSmbBaseUrl(source.baseUrl) : { host: "", share: "" };
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
      smbHost: smb.host,
      smbShare: smb.share,
      clientId: source.clientId || "",
      clientSecret: "",
      refreshToken: "",
      tokenExpiresAt: "",
      oauthCode: "",
    });
    setShareOptions([]);
    setTestResult("");
  }, []);

  return (
    <Overlay onClose={onClose}>
      <div className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-xl border border-app-border bg-white shadow-2xl  ">
        <div className="flex items-center gap-2 border-b border-app-border px-4 py-3 ">
          <Settings2 size={15} className="text-accent-primary" />
          <span className="text-sm font-semibold">管理远程源</span>
          <span className="flex-1" />
          <button
            type="button"
            className="rounded p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {sources.length === 0 && !draft ? (
            <p className="py-6 text-center text-xs text-tx-tertiary">尚未配置远程源，点击下方按钮新增。</p>
          ) : null}
          {sources.map((source) => (
            <div
              key={source.id}
              className="mb-2 flex items-center gap-2 rounded-lg border border-app-border px-3 py-2 "
            >
              <span className="rounded bg-app-hover px-1.5 py-0.5 text-[10px] font-medium text-tx-tertiary">
                {source.type}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{source.name}</p>
                <p className="truncate text-[10px] text-tx-tertiary">
                  {source.type === "baidu" ? "百度网盘" : source.baseUrl}
                  {source.rootPath ? ` · 根: ${source.rootPath}` : ""}
                </p>
                {testState[source.id] ? (
                  <p className="truncate text-[10px] text-emerald-500">{testState[source.id]}</p>
                ) : null}
              </div>
              <button
                type="button"
                title="测试连接"
                className="rounded p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
                onClick={() => void testSource(source)}
              >
                <Settings2 size={13} />
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
            <div className="mt-3 space-y-2 rounded-lg border border-app-border p-3 ">
              <div className="flex gap-2">
                <select
                  className="h-7 rounded border border-app-border bg-transparent px-1.5 text-xs "
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as SourceType })}
                >
                  <option value="webdav">WebDAV</option>
                  <option value="baidu">百度网盘（实验性）</option>
                  <option value="smb">SMB</option>
                </select>
                <input
                  className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                  placeholder="源名称，如：群晖 NAS"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              {draft.type === "smb" ? (
                <>
                  <div className="flex gap-2">
                    <input
                      className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                      placeholder="SMB 主机，如 192.168.100.3"
                      value={draft.smbHost}
                      onChange={(e) => setDraft({ ...draft, smbHost: e.target.value })}
                    />
                    <button
                      type="button"
                      disabled={busy || sharesLoading}
                      onClick={() => void loadShares()}
                      className="h-7 shrink-0 whitespace-nowrap rounded border border-app-border px-2 text-[11px] text-tx-secondary hover:bg-app-hover disabled:opacity-50"
                    >
                      {sharesLoading ? "获取中…" : "获取共享"}
                    </button>
                  </div>
                  <ShareSelect
                    value={draft.smbShare}
                    options={shareOptions}
                    onChange={(value) => setDraft({ ...draft, smbShare: value })}
                  />
                  <div className="flex gap-2">
                    <input
                      className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                      placeholder="域/工作组（可选）"
                      value={draft.domain}
                      onChange={(e) => setDraft({ ...draft, domain: e.target.value })}
                    />
                    <input
                      className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                      placeholder="用户名（可留空）"
                      value={draft.username}
                      onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                    />
                    <input
                      type="password"
                      className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                      placeholder={draft.id ? "密码（留空保持不变）" : "密码"}
                      value={draft.password}
                      onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                    />
                  </div>
                  <input
                    className="h-7 w-full rounded border border-app-border bg-transparent px-2 text-xs "
                    placeholder="共享内根路径（可选，如 /项目文档）"
                    value={draft.rootPath}
                    onChange={(e) => setDraft({ ...draft, rootPath: e.target.value })}
                  />
                  <p className="text-[10px] leading-4 text-tx-tertiary">
                    共享由服务端自动发现，无需手填路径；主机或共享变动时重新点「获取共享」即可。需 NAS/服务器可直连该 SMB 主机（445 端口）；支持 SMB 2.1 ~ 3.1.1 与 SMB3 传输加密。
                  </p>
                </>
              ) : draft.type === "webdav" ? (
                <>
                  <input
                    className="h-7 w-full rounded border border-app-border bg-transparent px-2 text-xs "
                    placeholder="服务器地址，如 https://nas.local:5006"
                    value={draft.baseUrl}
                    onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <input
                      className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                      placeholder="用户名（可留空）"
                      value={draft.username}
                      onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                    />
                    <input
                      type="password"
                      className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                      placeholder={draft.id ? "密码（留空保持不变）" : "密码"}
                      value={draft.password}
                      onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                    />
                  </div>
                  <input
                    className="h-7 w-full rounded border border-app-border bg-transparent px-2 text-xs "
                    placeholder="根路径（可选，如 /docs）"
                    value={draft.rootPath}
                    onChange={(e) => setDraft({ ...draft, rootPath: e.target.value })}
                  />
                </>
              ) : (
                <>
                  <input
                    type="password"
                    className="h-7 w-full rounded border border-app-border bg-transparent px-2 text-xs "
                    placeholder={draft.id ? "access_token（留空保持不变）" : "百度网盘 access_token"}
                    value={draft.accessToken}
                    onChange={(e) => setDraft({ ...draft, accessToken: e.target.value })}
                  />
                  <p className="text-[10px] leading-4 text-tx-tertiary">
                    手动路径：在百度网盘开放平台创建应用并完成授权后，把 access_token 粘贴到这里。支持分片上传大文件（超过 4MB 自动分片）。
                  </p>
                  <details className="rounded border border-app-border px-2 py-1 text-[11px] ">
                    <summary className="cursor-pointer select-none text-tx-tertiary">应用凭据（可选：授权码换令牌 + 30 天自动续期）</summary>
                    <div className="mt-1.5 space-y-1.5">
                      <div className="flex gap-2">
                        <input
                          className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                          placeholder="API Key（client_id）"
                          value={draft.clientId}
                          onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
                        />
                        <input
                          type="password"
                          className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                          placeholder="Secret Key（留空保持不变）"
                          value={draft.clientSecret}
                          onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-tx-tertiary hover:bg-app-hover"
                          disabled={busy || !draft.clientId}
                          onClick={() => void openBaiduAuthorize()}
                        >
                          打开授权页
                        </button>
                        <input
                          className="h-7 min-w-0 flex-1 rounded border border-app-border bg-transparent px-2 text-xs "
                          placeholder="粘贴授权码（oob 页面显示）"
                          value={draft.oauthCode}
                          onChange={(e) => setDraft({ ...draft, oauthCode: e.target.value })}
                        />
                        <button
                          type="button"
                          className="shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-tx-tertiary hover:bg-app-hover"
                          disabled={busy}
                          onClick={() => void exchangeBaiduCode()}
                        >
                          换令牌
                        </button>
                      </div>
                      <p className="text-[10px] leading-4 text-tx-tertiary">授权页登录后复制显示的授权码，点「换令牌」自动填入上方 access_token；配置凭据后令牌临近过期会自动续期。</p>
                    </div>
                  </details>
                </>
              )}
              {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
              {testResult ? (
                <p className={`break-words text-[11px] ${testResult === "连接成功" ? "text-emerald-600" : "text-tx-tertiary"}`}>
                  {testResult}
                </p>
              ) : null}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  className="shrink-0 whitespace-nowrap rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                  disabled={busy || !draft.name.trim()}
                  onClick={() => void save()}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="shrink-0 whitespace-nowrap rounded-md border border-app-border px-3 py-1 text-xs "
                  disabled={busy}
                  onClick={() => void testConnection()}
                >
                  测试连接
                </button>
                <span className="min-w-0 flex-1" />
                <button
                  type="button"
                  className="shrink-0 whitespace-nowrap text-xs text-tx-tertiary hover:text-tx-secondary"
                  onClick={() => { setDraft(null); setError(""); }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-app-border py-2 text-xs text-tx-tertiary hover:border-accent-primary hover:text-accent-primary"
              onClick={() => { setDraft(emptyDraft()); setShareOptions([]); setTestResult(""); }}
            >
              <Plus size={13} /> 新增远程源
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/** ============ 主区中心 ============ */
export default function RemoteFilesPanel() {
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

  const [openPath, setOpenPath] = useState("");
  const [editorText, setEditorText] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [links, setLinks] = useState<RemoteNoteLink[]>([]);
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
      .then((r) => setLinks(r.links))
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

  /** 远程文本文件 → 本地笔记（markdown → Tiptap JSON，零后端改动） */
  const importToNote = useCallback(async (entry: RemoteFileEntry) => {
    if (!activeId) return;
    try {
      const res = await api.readRemoteFile(activeId, entry.path);
      const json = markdownToTiptapJSON(res.content);
      const title = entry.name.replace(/\.[^.]+$/, "") || "未命名";
      const note = await api.createNote({
        title,
        content: JSON.stringify(json),
        contentText: res.content.replace(/[#*`>\-|_\[\]()]/g, "").replace(/\n{2,}/g, "\n").trim(),
      });
      flash(`已导入为笔记「${title}」`);
      // 建立同步映射：基线 = 导入时的远程内容与笔记 markdown
      const baseRemoteHash = fnvHash(res.content);
      const baseNoteHash = fnvHash(normalizeToMarkdown(JSON.stringify(json)) || "");
      try {
        await api.linkRemoteNote({ sourceId: activeId, remotePath: entry.path, noteId: note.id, title, baseRemoteHash, baseNoteHash });
        loadLinks();
      } catch { /* 映射失败不影响导入 */ }
    } catch (err: any) {
      flash(err?.message || "导入为笔记失败");
    }
  }, [activeId, flash, loadLinks]);

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

  // 侧栏类型 chips + 排序（filesUi 共享 store，事件驱动刷新）
  const filesUiVersion = useSyncExternalStore(subscribeFilesUi, getFilesUiVersion);
  void filesUiVersion;
  const remoteTypes = getFilesRemoteTypes();
  const remoteSort = getFilesRemoteSort();
  // 文件夹始终置顶且不受类型过滤影响；类型/搜索/排序只作用于文件条目。
  const displayedEntries = filterSortRemoteEntries(entries, remoteQuery, remoteTypes, remoteSort, getFilesRemoteTime());

  const reloadSources = useCallback(async () => {
    try {
      const res = await api.getRemoteFileSources();
      setSources(res.sources);
      setActiveId((prev) => (prev && res.sources.some((s) => s.id === prev) ? prev : res.sources[0]?.id || ""));
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => { void reloadSources(); }, [reloadSources]);

  useEffect(() => { loadLinks(); }, [loadLinks, activeId]);

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

  const crumbs = cwd ? cwd.split("/") : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：h-12 与模块面板头同一节奏；存储切换在侧栏 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-app-border px-4">
        <Cloud size={18} className="shrink-0 text-tx-secondary" />
        <span className="text-[15px] font-semibold">远程文件</span>
        <span className="rounded-lg bg-app-hover px-1.5 py-px text-[10.5px] tabular-nums text-tx-tertiary">
          {entries.length} 个文件
        </span>
        <span className="flex-1" />
        <button
          type="button"
          title="刷新"
          className="inline-flex items-center gap-1 rounded-lg border border-app-border bg-app-bg px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover"
          onClick={() => activeId && void loadList(activeId, cwd)}
        >
          <RefreshCw size={13} /> 刷新
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-app-border bg-app-bg px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover"
          onClick={() => setManagerOpen(true)}
        >
          ＋ 配置存储
        </button>
      </div>

            {/* 搜索 + 当前存储 */}
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-app-border px-4 text-xs">
              <span className="flex items-center gap-1.5 rounded-lg bg-app-hover px-2.5 py-1 text-tx-tertiary">
                <Search size={13} />
                <input
                  value={remoteQuery}
                  onChange={(e) => setRemoteQuery(e.target.value)}
                  placeholder="搜索远程文件…"
                  className="w-48 border-none bg-transparent text-tx-primary outline-none no-focus-ring placeholder:text-tx-tertiary"
                />
              </span>
              <span className="ml-auto text-tx-tertiary">
                {activeSource ? `当前存储：${activeSource.name}${cwd ? ` · /${cwd}` : ""}` : ""}
              </span>
            </div>

      {sources.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-tx-tertiary">
          <Cloud size={32} className="opacity-40" />
          <p>尚未配置远程源（WebDAV / 百度网盘）</p>
          <button
            type="button"
            className="rounded-md bg-accent-primary px-3 py-1.5 text-xs font-medium text-white"
            onClick={() => setManagerOpen(true)}
          >
            添加远程源
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 文件浏览器 */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* 面包屑 + 工具行 */}
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-app-border px-4 text-xs">
              <button type="button" className="text-tx-tertiary hover:text-accent-primary" onClick={() => setCwd("")}>
                {activeSource?.name || "根目录"}
              </button>
              {crumbs.map((part, index) => (
                <React.Fragment key={`${index}-${part}`}>
                  <ChevronRight size={11} className="text-app-border" />
                  <button
                    type="button"
                    className="text-tx-tertiary hover:text-accent-primary"
                    onClick={() => setCwd(crumbs.slice(0, index + 1).join("/"))}
                  >
                    {part}
                  </button>
                </React.Fragment>
              ))}
              <span className="flex-1" />
              {actionMsg ? <span className="text-[11px] text-emerald-500">{actionMsg}</span> : null}
              {newFolderOpen ? (
                <span className="flex items-center gap-1">
                  <input
                    autoFocus
                    className="h-6 w-36 rounded border border-app-border bg-transparent px-1.5 text-xs "
                    placeholder="新文件夹名"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); if (e.key === "Escape") setNewFolderOpen(false); }}
                  />
                  <button type="button" className="text-accent-primary" onClick={() => void createFolder()}>确定</button>
                  <button type="button" className="text-tx-tertiary" onClick={() => setNewFolderOpen(false)}>取消</button>
                </span>
              ) : (
                <button
                  type="button"
                  title="新建文件夹"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
                  onClick={() => { setNewFolderOpen(true); setNewFolderName(""); }}
                >
                  <FolderPlus size={13} /> 新建文件夹
                </button>
              )}
            </div>


            {/* 条目列表 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
              {listLoading ? (
                <p className="py-8 text-center text-xs text-tx-tertiary">加载中…</p>
              ) : listError ? (
                <p className="py-8 text-center text-xs text-red-400">{listError}</p>
              ) : entries.length === 0 ? (
                <p className="py-8 text-center text-xs text-tx-tertiary">空目录</p>
              ) : displayedEntries.length === 0 ? (
                <p className="py-8 text-center text-xs text-tx-tertiary">没有匹配的远程文件</p>
              ) : (
                displayedEntries.map((entry) => (
                  <div
                    key={entry.path}
                    className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-app-hover ${openPath === entry.path ? "bg-app-hover" : ""}`}
                  >
                    {entry.isFolder ? (
                      <Folder size={14} className="shrink-0 text-amber-500" />
                    ) : (
                      <FileText size={14} className="shrink-0 text-sky-500" />
                    )}
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      onClick={() => (entry.isFolder ? (setCwd(entry.path), setOpenPath("")) : void openFile(entry))}
                    >
                      {entry.name}
                      {linkForEntry(entry) ? <span className="ml-1 text-[10px] text-sky-400">已链接</span> : null}
                    </button>
                    <span className="w-16 shrink-0 text-right text-[10px] text-tx-tertiary">
                      {entry.isFolder ? "—" : formatSize(entry.size)}
                    </span>
                    <span className="hidden w-36 shrink-0 truncate text-right text-[10px] text-tx-tertiary md:block">
                      {formatTime(entry.modifiedAt)}
                    </span>
                    <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                      {!entry.isFolder && linkForEntry(entry) ? (
                        <button
                          type="button"
                          title="与笔记对比 / 同步"
                          className="rounded p-1 text-sky-400 hover:text-sky-300"
                          onClick={() => void openDiff(entry, linkForEntry(entry)!)}
                        >
                          <GitCompare size={12} />
                        </button>
                      ) : null}
                      {!entry.isFolder && (
                        <button
                          type="button"
                          title={isTextFileName(entry.name) ? "导入为笔记" : "仅文本类文件可导入为笔记"}
                          className="rounded p-1 text-tx-tertiary hover:text-accent-primary disabled:opacity-40"
                          disabled={!isTextFileName(entry.name)}
                          onClick={() => void importToNote(entry)}
                        >
                          <NotebookPen size={12} />
                        </button>
                      )}
                      {!entry.isFolder && (
                        <button
                          type="button"
                          title="存到文件管理"
                          className="rounded p-1 text-tx-tertiary hover:text-accent-primary"
                          onClick={() => void saveToLocal(entry)}
                        >
                          <Download size={12} />
                        </button>
                      )}
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
                ))
              )}
            </div>
          </div>

          {/* 编辑器 */}
          <div className="flex min-h-0 w-[42%] shrink-0 flex-col border-l border-app-border ">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-app-border px-3 text-xs ">
              <FileText size={13} className="shrink-0 text-sky-500" />
              <span className="min-w-0 flex-1 truncate text-tx-tertiary">{openPath || "未打开文件"}</span>
              {openPath ? (
                <>
                  {dirty ? <span className="text-[10px] text-amber-500">未保存</span> : null}
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-md bg-accent-primary px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                    disabled={saving || !dirty}
                    onClick={() => void saveFile()}
                  >
                    <Save size={11} /> {saving ? "保存中…" : "写回远程"}
                  </button>
                  <button
                    type="button"
                    title="关闭"
                    className="rounded p-1 text-tx-tertiary hover:text-tx-secondary"
                    onClick={() => { setOpenPath(""); setEditorText(""); setDirty(false); }}
                  >
                    <X size={13} />
                  </button>
                </>
              ) : null}
            </div>
            {editorLoading ? (
              <p className="flex-1 py-8 text-center text-xs text-tx-tertiary">读取中…</p>
            ) : openPath ? (
              <textarea
                className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                spellCheck={false}
                value={editorText}
                onChange={(e) => { setEditorText(e.target.value); setDirty(true); }}
              />
            ) : (
              <p className="flex-1 py-8 text-center text-xs text-tx-tertiary">
                点击左侧文本文件（md / txt / json 等）进行读取与编辑
              </p>
            )}
          </div>
        </div>
      )}

      {diffDlg ? (
        <Overlay onClose={() => setDiffDlg(null)}>
          <div className="w-[430px] rounded-xl border border-app-border bg-white p-4 shadow-2xl  ">
            <p className="text-xs font-semibold text-tx-primary">
              同步：{diffDlg.entry.name} ↔ 笔记
            </p>
            <div className="mt-2 space-y-1 text-[11px] leading-5 text-tx-tertiary dark:text-tx-tertiary">
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
                <button
                  type="button"
                  disabled={diffDlg.busy}
                  className="rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                  onClick={() => void syncFromRemote()}
                >
                  远程 → 笔记
                </button>
              ) : null}
              {diffDlg.noteChanged ? (
                <button
                  type="button"
                  disabled={diffDlg.busy}
                  className="rounded-md border border-app-border px-3 py-1 text-xs text-tx-secondary hover:bg-app-hover"
                  onClick={() => void syncFromNote()}
                >
                  笔记 → 远程
                </button>
              ) : null}
              <button
                type="button"
                disabled={diffDlg.busy}
                className="text-[11px] text-tx-tertiary hover:text-red-500"
                onClick={() => { void unlinkNote(diffDlg.entry, diffDlg.link); setDiffDlg(null); }}
              >
                解除链接
              </button>
              <button
                type="button"
                disabled={diffDlg.busy}
                className="rounded-md border border-app-border px-3 py-1 text-xs text-tx-secondary "
                onClick={() => setDiffDlg(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {renameTarget ? (
        <Overlay onClose={() => setRenameTarget(null)}>
          <div className="w-80 rounded-xl border border-app-border bg-white p-4 shadow-2xl  ">
            <p className="mb-2 text-xs font-semibold">重命名</p>
            <input
              autoFocus
              className="h-8 w-full rounded border border-app-border bg-transparent px-2 text-xs "
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submitRename(); if (e.key === "Escape") setRenameTarget(null); }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className="rounded-md border border-app-border px-3 py-1 text-xs " onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button type="button" className="rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white" onClick={() => void submitRename()}>
                确定
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {managerOpen ? (
        <SourceManager
          sources={sources}
          onClose={() => setManagerOpen(false)}
          onChanged={() => void reloadSources()}
        />
      ) : null}
    </div>
  );
}
