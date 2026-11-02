/**
 * 插件中心的全局能力分区（仅管理员）
 * ---------------------------------------------------------------------------
 * 原先是单个「管理」分组面板；按最新信息架构拆成几块，供工作区分组组合：
 * - usePluginUpdateCheck + PluginUpdatesResult：「检查更新」触发与结果区
 *   （触发按钮挂在主区「管理」分组的社区插件区头部，结果也展示在该分区内）；
 * - PluginPackageInstallSection：「安装插件包」按钮 + 安装确认弹窗（同上，社区插件区头部）；
 * - PluginConfigPanel：「执行边界」「Registry 来源与国内镜像」「开发者模式」
 *   等配置类内容（挂在主区「配置」分组）。
 * 单插件的配置（设置项/连接/Actions）在插件详情页的「设置与运行」分区，不在这里。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { Code2, Loader2, PackagePlus, ShieldCheck } from "lucide-react";
import {
  pluginApi,
  type PluginUpdate,
  type RegistrySource,
} from "@/lib/pluginApi";
import { getPluginRuntimePresentation } from "@/lib/pluginRuntimePresentation";
import { alert, confirm } from "@/components/ui/confirm";
import { PluginRuntimePolicySettings } from "@/components/settings/plugins/PluginRuntimePolicySettings";
import { ExternalHostList } from "@/components/plugins/ExternalHostList";

type PendingManifest = {
  id?: string;
  name?: string;
  version?: string;
  runtime?: string;
  executionMode?: string;
  permissions?: string[];
  permissionConfig?: { externalFetchHosts?: string[] };
};

type PendingPackage = { file: File; manifest: PendingManifest; nodeRuntimeConfirmationRequired: boolean };

const FIELD = "w-full rounded-md border border-app-border bg-transparent px-2 py-1.5 text-xs text-tx-primary";
const BUTTON = "rounded-md border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-tx-primary transition-colors hover:bg-app-hover disabled:opacity-50";

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div
      className="mt-4 rounded-lg border border-app-border bg-app-surface p-4"
      data-plugin-admin-panel={title}
    >
      <h3 className="text-sm font-semibold text-tx-primary">{title}</h3>
      {description && <p className="mt-1 text-xs text-tx-tertiary">{description}</p>}
      {children}
    </div>
  );
}

const PERMISSION_LABELS: Record<string, string> = {
  "notes:read": "读取笔记", "notes:write": "创建和修改笔记",
  "notebooks:read": "读取笔记本", "notebooks:write": "创建和修改笔记本",
  "tags:read": "读取标签", "tags:write": "创建和修改标签",
  "tasks:read": "读取任务", "tasks:write": "创建和修改任务",
  "attachments:read": "读取附件信息", "attachments:write": "创建和修改附件",
  "plugin-storage:read": "读取插件自己的数据", "plugin-storage:write": "保存插件自己的数据",
  "capture:write": "抓取公网 HTTPS 文章和图片，保存到有写入权限的笔记本",
  "external:fetch": "访问声明的外部网络服务", "secrets:use": "使用你配置的连接密钥（插件看不到原值）",
  "diary:read": "读取日记", "diary:write": "创建和修改日记",
  "mindmaps:read": "读取思维导图", "mindmaps:write": "创建和修改思维导图",
};

/**
 * 「检查更新」触发逻辑：签名 Registry 的版本比对，管理员人工确认权限/Runtime 变化。
 * 状态上提给调用方，让触发按钮（社区插件区头部）与结果区（同分区内）共享。
 */
export function usePluginUpdateCheck() {
  const [updates, setUpdates] = useState<PluginUpdate[] | null>(null);
  const [updateSource, setUpdateSource] = useState("official-v2");
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setUpdates(await pluginApi.checkUpdates(updateSource));
    } catch (error) {
      void alert({ title: "检查更新失败", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setChecking(false);
    }
  }, [updateSource]);

  return { updates, updateSource, setUpdateSource, checking, check };
}

/** 「检查更新」结果区：仅在检查过一次后显示；可改更新源后再次点「检查更新」复核 */
export function PluginUpdatesResult({ updates, updateSource, onSourceChange }: {
  updates: PluginUpdate[] | null;
  updateSource: string;
  onSourceChange: (value: string) => void;
}) {
  if (updates === null) return null;
  return (
    <div className="mt-3 rounded-lg border border-app-border bg-app-bg p-3" data-plugin-updates-result>
      <label className="flex items-center gap-2 text-[11px] text-tx-tertiary">
        更新源
        <input
          value={updateSource}
          onChange={(event) => onSourceChange(event.target.value)}
          placeholder="V2 Registry Source ID"
          className={`${FIELD} max-w-56`}
        />
      </label>
      {updates.length ? (
        <div className="mt-2 space-y-2">
          {updates.map((update) => (
            <div key={update.pluginId} className="rounded-lg bg-app-hover p-3 text-xs text-tx-secondary">
              <div className="font-mono text-tx-primary">{update.pluginId}</div>
              <div className="mt-1">{update.currentVersion} → {update.availableVersion}</div>
              {update.permissionDiff.added.length > 0 && (
                <div className="mt-1 text-amber-600">新增权限：{update.permissionDiff.added.join("、")}</div>
              )}
              <div className="mt-1 text-tx-tertiary">{update.confirmationRequired ? "需要管理员确认" : "符合自动更新条件"}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-tx-tertiary">没有可用更新。</p>
      )}
    </div>
  );
}

/** 「安装插件包」紧凑操作：按钮 + 安装确认弹窗（挂在社区插件区头部，与市场安装走同一套校验） */
export function PluginPackageInstallSection({ onInstalled }: {
  /** 安装成功后的回调：刷新工作区列表并跳到「管理」列表 */
  onInstalled: () => Promise<void>;
}) {
  const [pending, setPending] = useState<PendingPackage | null>(null);
  const [installing, setInstalling] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const choosePackage = async (file?: File) => {
    if (!file) return;
    try {
      const zip = await JSZip.loadAsync(file);
      const manifestFile = zip.file("manifest.json");
      if (!manifestFile) throw new Error("插件包缺少 manifest.json");
      setPending({
        file,
        manifest: JSON.parse(await manifestFile.async("string")) as PendingManifest,
        nodeRuntimeConfirmationRequired: false,
      });
    } catch (error) {
      void alert({ title: "无法读取插件包", description: error instanceof Error ? error.message : String(error) });
    }
  };

  const install = async () => {
    if (!pending) return;
    setInstalling(true);
    try {
      await pluginApi.install(pending.file, pending.nodeRuntimeConfirmationRequired);
      setPending(null);
      if (inputRef.current) inputRef.current.value = "";
      await onInstalled();
    } catch (error) {
      const coded = error as Error & { code?: string; confirmNodeRuntimeAllowed?: boolean };
      if (coded.code === "PLUGIN_NODE_RUNTIME_CONFIRMATION_REQUIRED" && coded.confirmNodeRuntimeAllowed) {
        setPending((current) => (current ? { ...current, nodeRuntimeConfirmationRequired: true } : current));
      } else {
        void alert({ title: "安装失败", description: coded.message || String(error) });
      }
    } finally {
      setInstalling(false);
    }
  };

  const pendingRuntime = pending ? getPluginRuntimePresentation(pending.manifest) : null;

  return (
    <>
      <div className="inline-flex shrink-0">
        <input
          ref={inputRef}
          type="file"
          accept=".nowen-plugin"
          className="hidden"
          onChange={(event) => void choosePackage(event.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-tx-primary transition-colors hover:bg-app-hover"
        >
          <PackagePlus size={13} />安装插件包
        </button>
      </div>

      {pending && pendingRuntime && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg space-y-4 rounded-2xl bg-app-surface p-5 shadow-2xl">
            <div>
              <h3 className="text-lg font-bold text-tx-primary">安装 {pending.manifest.name || "社区插件"}</h3>
              <p className="mt-1 font-mono text-xs text-tx-tertiary">{pending.manifest.id} · v{pending.manifest.version}</p>
            </div>
            {pendingRuntime.declarative ? (
              <div className="rounded-lg border border-emerald-200/70 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">
                <div className="flex gap-2">
                  <ShieldCheck className="mt-0.5 shrink-0" size={16} />
                  <span>这是声明式零代码扩展：不会运行 JS / WASM / Node，不执行 Action，也不能请求笔记、附件、网络或密钥数据权限。安装仍会校验签名、校验和与兼容性。</span>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                <span>
                  {pending.nodeRuntimeConfirmationRequired
                    ? "此插件将在独立 Node 进程中执行二进制/Node 代码，可使用获准的文件系统与网络权限，且不能由 QuickJS/WASM Sandbox 隔离。请仅在完全信任来源时继续。"
                    : "此插件包含社区开发者的可执行代码；安装前将校验兼容性、信任等级和 Runtime 策略。"}
                </span>
              </div>
            )}
            <div>
              <h4 className="mb-2 text-sm font-semibold text-tx-primary">权限与执行边界</h4>
              <ul className="space-y-1 text-sm text-tx-secondary">
                {pending.manifest.permissions?.length ? pending.manifest.permissions.map((permission) => (
                  <li key={permission}>✓ {PERMISSION_LABELS[permission] || permission}</li>
                )) : (
                  <li className="text-tx-tertiary">
                    {pendingRuntime.declarative ? "零数据权限（由 Manifest 校验强制保证）" : "不请求数据权限"}
                  </li>
                )}
              </ul>
              {/* external:fetch 的具体域名来自 manifest.permissionConfig.externalFetchHosts */}
              <ExternalHostList
                hosts={pending.manifest.permissionConfig?.externalFetchHosts || []}
                className="mt-2 pl-0"
              />
            </div>
            <p className="text-xs text-tx-tertiary">
              {pendingRuntime.declarative
                ? "安装后默认进入隔离状态；启用只会注册声明资源，不会启动代码 Runner。"
                : pending.nodeRuntimeConfirmationRequired
                  ? "确认后将使用同一文件重新提交；取消则不会安装。"
                  : "安装后默认进入隔离状态；你需要再次确认权限并启用。"}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setPending(null); if (inputRef.current) inputRef.current.value = ""; }}
                className={BUTTON}
              >
                取消
              </button>
              <button
                type="button"
                disabled={installing}
                onClick={() => void install()}
                className="rounded-md bg-accent-primary px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                {installing ? "正在验证" : pendingRuntime.declarative ? "安装声明式扩展" : pending.nodeRuntimeConfirmationRequired ? "确认 Node 风险并安装" : "继续安装"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 「配置」分组面板：执行边界、Registry 来源与国内镜像、开发者模式（仅管理员） */
export function PluginConfigPanel({ isAdmin, onInstalled }: {
  isAdmin: boolean;
  /** 开发插件加载成功后的回调：刷新工作区列表并跳到「管理」列表 */
  onInstalled: () => Promise<void>;
}) {
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [newSourceKeyId, setNewSourceKeyId] = useState("");
  const [newSourcePublicKey, setNewSourcePublicKey] = useState("");
  const [developerMode, setDeveloperMode] = useState(false);
  const [developerModeAvailable, setDeveloperModeAvailable] = useState(false);
  const [devDirectory, setDevDirectory] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pluginApi.registrySources().then(setSources).catch(() => setSources([]));
    void pluginApi.getDeveloperMode()
      .then((value) => { setDeveloperMode(value.enabled); setDeveloperModeAvailable(value.available); })
      .catch(() => undefined);
  }, []);

  if (!isAdmin) {
    return (
      <div className="mt-6 rounded-lg border border-dashed border-app-border py-10 text-center text-sm text-tx-tertiary">
        插件配置仅对管理员开放。
      </div>
    );
  }

  const loadDevelopment = async () => {
    setBusy(true);
    try {
      try {
        await pluginApi.loadDevelopment(devDirectory);
      } catch (error) {
        const coded = error as Error & { code?: string; confirmNodeRuntimeAllowed?: boolean };
        if (coded.code !== "PLUGIN_NODE_RUNTIME_CONFIRMATION_REQUIRED" || !coded.confirmNodeRuntimeAllowed) throw error;
        const confirmed = await confirm({
          title: "信任并加载此开发插件？",
          description: "它将在独立 Node 进程中运行，不能由 QuickJS/WASM Sandbox 隔离，并可使用获准的文件系统与网络权限。",
          confirmText: "信任并加载",
          danger: true,
        });
        if (!confirmed) return;
        await pluginApi.loadDevelopment(devDirectory, true);
      }
      await onInstalled();
    } catch (error) {
      void alert({ title: "加载开发插件失败", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Panel title="执行边界">
        <div className="mt-3">
          <PluginRuntimePolicySettings />
        </div>
      </Panel>

      <Panel
        title="Registry 来源与国内镜像"
        description="官方源使用客户端内置 Ed25519 信任根；自定义源必须提供 HTTPS Index 和管理员固定的 Registry 公钥。"
      >
        <div className="mt-3 space-y-1">
          {sources.map((source) => (
            <div key={source.id} className="rounded bg-app-hover px-2 py-1.5 text-[11px] text-tx-secondary">
              <div className="truncate">{source.name} · {source.indexUrl}</div>
              <div className="mt-0.5 text-tx-tertiary">
                {source.official ? "客户端内置信任根" : `Pinned key: ${source.registryKeyId}`}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input value={newSourceName} onChange={(event) => setNewSourceName(event.target.value)} placeholder="镜像名称" className={FIELD} />
          <input value={newSourceUrl} onChange={(event) => setNewSourceUrl(event.target.value)} placeholder="https://mirror.example/v2/index.json" className={FIELD} />
          <input value={newSourceKeyId} onChange={(event) => setNewSourceKeyId(event.target.value)} placeholder="Registry Key ID" className={FIELD} />
          <textarea
            value={newSourcePublicKey}
            onChange={(event) => setNewSourcePublicKey(event.target.value)}
            placeholder="-----BEGIN PUBLIC KEY-----"
            className="min-h-20 rounded-md border border-app-border bg-transparent px-2 py-1.5 font-mono text-xs text-tx-primary"
          />
        </div>
        <button
          type="button"
          className={`mt-2 ${BUTTON}`}
          onClick={async () => {
            const id = `mirror-${Date.now().toString(36)}`;
            const updated = await pluginApi.setRegistrySource({
              id,
              name: newSourceName || "Custom Registry",
              indexUrl: newSourceUrl,
              registryKeyId: newSourceKeyId,
              registryPublicKey: newSourcePublicKey,
            });
            setSources(updated);
            setNewSourceName("");
            setNewSourceUrl("");
            setNewSourceKeyId("");
            setNewSourcePublicKey("");
          }}
        >
          添加自定义源
        </button>
      </Panel>

      <Panel title="开发者模式" description="本地目录仍需 Validate、Preflight 和权限确认；开发插件不进入备份。">
        {developerModeAvailable ? (
          <>
            <label className="mt-3 flex items-center justify-between gap-3 text-xs text-tx-secondary">
              <span className="inline-flex items-center gap-1.5"><Code2 size={13} />启用本地开发插件加载</span>
              <input
                type="checkbox"
                checked={developerMode}
                onChange={async (event) => {
                  const enabled = event.target.checked;
                  await pluginApi.setDeveloperMode(enabled);
                  setDeveloperMode(enabled);
                }}
              />
            </label>
            {developerMode && (
              <div className="mt-2 flex gap-2">
                <input
                  value={devDirectory}
                  onChange={(event) => setDevDirectory(event.target.value)}
                  placeholder="D:\\Projects\\my-plugin"
                  className={FIELD}
                />
                <button type="button" disabled={busy || !devDirectory.trim()} onClick={() => void loadDevelopment()} className={`shrink-0 ${BUTTON}`}>
                  {busy ? <Loader2 size={13} className="animate-spin" /> : "Validate & Load"}
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="mt-3 text-xs text-tx-tertiary">开发者模式仅对管理员和本地 Desktop Backend 开放。</p>
        )}
      </Panel>
    </div>
  );
}
