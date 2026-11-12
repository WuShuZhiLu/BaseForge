/**
 * 插件详情里的「配置与运行」分区
 * ---------------------------------------------------------------------------
 * 插件自有设置项、连接密钥、Actions 试跑、Automation 模板、Inbound webhook、
 * 最近执行记录。这些区块原先长在 设置 → 插件 的卡片里；插件入口合并到插件中心
 * 之后由详情页直接复用，同一份能力只维护一遍。
 *
 * 权限列表与版本历史不在这里：工作区的详情页已经有独立分区。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Play } from "lucide-react";
import {
  pluginApi,
  type InstalledPlugin,
  type PluginAction,
  type PluginConnection,
  type PluginExecution,
} from "@/lib/pluginApi";
import { getPluginRuntimePresentation } from "@/lib/pluginRuntimePresentation";
import { alert } from "@/components/ui/confirm";
import { WechatCaptureSettings } from "@/components/settings/plugins/WechatCaptureSettings";
import { PluginInboundSettings } from "@/components/settings/plugins/PluginInboundSettings";

/** 微信采集插件有自己的整块设置 UI，不再叠加 Actions / 连接 / 插件设置。 */
const WECHAT_PLUGIN_ID = "baseforgelab.wechat-capture";

const FIELD = "w-full rounded-md border border-app-border bg-transparent px-2 py-1.5 text-xs text-tx-primary";
const BUTTON = "rounded-md border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-tx-primary transition-colors hover:bg-app-hover disabled:opacity-50";

function ActionTester({ plugin, action }: { plugin: InstalledPlugin; action: PluginAction }) {
  const initial = useMemo(
    () => Object.fromEntries(Object.entries(action.input || {}).map(([key, field]) => [
      key,
      field.type === "boolean" ? false : field.type === "number" ? 0 : "",
    ])),
    [action],
  );
  const [input, setInput] = useState(JSON.stringify(initial, null, 2));
  const [result, setResult] = useState("");
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    setResult("");
    try {
      setResult(JSON.stringify(await pluginApi.execute(plugin.id, action.id, JSON.parse(input)), null, 2));
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-app-border p-3">
      <div>
        <div className="text-sm font-medium text-tx-primary">{action.name}</div>
        <div className="text-xs text-tx-tertiary">{action.description || action.id}</div>
      </div>
      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        className="min-h-24 w-full rounded-md border border-app-border bg-transparent p-2 font-mono text-xs text-tx-primary"
        aria-label={`${action.name} 参数`}
      />
      <button
        type="button"
        onClick={run}
        disabled={running || plugin.status !== "enabled"}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        <Play size={13} />{running ? "执行中" : "执行"}
      </button>
      {result && <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-app-hover p-2 text-xs text-tx-secondary">{result}</pre>}
    </div>
  );
}

export function PluginConfigSections({ plugin, onChanged }: {
  plugin: InstalledPlugin;
  /** 保存设置 / 装模板 / 存密钥后通知父级刷新插件列表与徽标 */
  onChanged?: () => Promise<void> | void;
}) {
  const presentation = getPluginRuntimePresentation(plugin);
  const [busy, setBusy] = useState(false);
  const [executions, setExecutions] = useState<PluginExecution[]>([]);
  const [connections, setConnections] = useState<PluginConnection[]>([]);
  const [connectionValues, setConnectionValues] = useState<Record<string, string>>({});
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});
  const [settingDraft, setSettingDraft] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    try {
      const [runs, configured, settings] = await Promise.all([
        presentation.declarative ? Promise.resolve([] as PluginExecution[]) : pluginApi.executions(plugin.id).catch(() => []),
        presentation.declarative ? Promise.resolve([] as PluginConnection[]) : pluginApi.connections(plugin.id).catch(() => []),
        pluginApi.settings(plugin.id).catch(() => ({} as Record<string, unknown>)),
      ]);
      setExecutions(runs);
      setConnections(configured);
      setSettingValues(settings);
    } catch {
      // 接口不可用（或测试环境未实现）时保持空态，不阻断详情页其它分区
    }
  }, [plugin.id, presentation.declarative]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await onChanged?.();
      await load();
    } catch (error) {
      void alert({ title: "操作失败", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const isWechat = plugin.id === WECHAT_PLUGIN_ID;

  return (
    <div className="space-y-4">
      {isWechat && <WechatCaptureSettings />}
      {!isWechat && !!plugin.contributes?.inboundWebhooks?.length && <PluginInboundSettings plugin={plugin} />}

      {!isWechat && (presentation.canExecuteActions ? (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-tx-primary">Actions</h4>
          {(plugin.actions || []).map((action) => <ActionTester key={action.id} plugin={plugin} action={action} />)}
        </div>
      ) : (
        <div className="rounded-lg bg-app-hover p-3 text-xs text-tx-tertiary">
          执行能力：无。声明式扩展不能执行 Action，也不会创建代码 Runner。
        </div>
      ))}

      {!isWechat && connections.length > 0 && (
        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-tx-primary"><KeyRound size={13} />连接</h4>
          {connections.map((connection) => (
            <div key={connection.id} className="rounded-lg border border-app-border p-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-tx-primary">{connection.name} · {connection.type}</span>
                <span className={connection.configured ? "text-emerald-600" : "text-tx-tertiary"}>{connection.configured ? "已配置" : "未配置"}</span>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  type="password"
                  value={connectionValues[connection.id] || ""}
                  onChange={(event) => setConnectionValues((current) => ({ ...current, [connection.id]: event.target.value }))}
                  placeholder="密钥仅由 Host 加密保存并注入"
                  className={FIELD}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(async () => {
                    await pluginApi.setConnection(plugin.id, connection.id, connectionValues[connection.id] || "");
                    setConnectionValues((current) => ({ ...current, [connection.id]: "" }));
                  })}
                  className={BUTTON}
                >
                  保存
                </button>
                {connection.configured && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(() => pluginApi.removeConnection(plugin.id, connection.id))}
                    className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!isWechat && !!plugin.contributes?.settings?.length && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-tx-primary">插件设置</h4>
          {plugin.contributes.settings.map((setting) => (
            <label key={setting.key} className="block rounded-lg border border-app-border p-2 text-xs text-tx-secondary">
              <span className="font-medium text-tx-primary">{setting.title}</span>
              {setting.description && <span className="ml-2 text-tx-tertiary">{setting.description}</span>}
              {setting.type === "boolean" ? (
                <input
                  type="checkbox"
                  className="ml-3"
                  checked={Boolean(settingDraft[setting.key] ?? settingValues[setting.key] ?? setting.default)}
                  onChange={(event) => setSettingDraft((current) => ({ ...current, [setting.key]: event.target.checked }))}
                />
              ) : setting.type === "select" ? (
                <select
                  className={`mt-2 block ${FIELD}`}
                  value={String(settingDraft[setting.key] ?? settingValues[setting.key] ?? setting.default ?? "")}
                  onChange={(event) => setSettingDraft((current) => ({ ...current, [setting.key]: event.target.value }))}
                >
                  {(setting.options || []).map((option) => <option key={String(option)} value={String(option)}>{option}</option>)}
                </select>
              ) : (
                <input
                  type={setting.secret ? "password" : setting.type === "number" ? "number" : "text"}
                  className={`mt-2 block ${FIELD}`}
                  value={String(settingDraft[setting.key] ?? (setting.secret ? "" : settingValues[setting.key] ?? setting.default ?? ""))}
                  placeholder={setting.secret && settingValues[setting.key] ? "已安全保存；输入新值以替换" : ""}
                  onChange={(event) => setSettingDraft((current) => ({
                    ...current,
                    [setting.key]: setting.type === "number" ? Number(event.target.value) : event.target.value,
                  }))}
                />
              )}
            </label>
          ))}
          <button
            type="button"
            disabled={busy || !Object.keys(settingDraft).length}
            onClick={() => void act(async () => {
              setSettingValues(await pluginApi.setSettings(plugin.id, settingDraft));
              setSettingDraft({});
            })}
            className="rounded-md bg-accent-primary px-2.5 py-1.5 text-xs text-white disabled:opacity-40"
          >
            保存设置
          </button>
        </div>
      )}

      {!!plugin.contributes?.automationTemplates?.length && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-tx-primary">Automation 模板</h4>
          {plugin.contributes.automationTemplates.map((template) => (
            <div key={template.id} className="flex items-center justify-between rounded-lg border border-app-border p-2 text-xs">
              <div>
                <div className="font-medium text-tx-primary">{template.title}</div>
                <div className="text-tx-tertiary">{template.description || "安装后保持禁用，需在自动化中心确认"}</div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => pluginApi.installAutomationTemplate(plugin.id, template.id))}
                className={BUTTON}
              >
                安装模板
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        <h4 className="mb-2 text-xs font-semibold text-tx-primary">最近执行</h4>
        {presentation.declarative ? (
          <p className="text-xs text-tx-tertiary">声明式扩展没有执行进程或执行记录。</p>
        ) : executions.length ? (
          <div className="max-h-48 space-y-1 overflow-auto">
            {executions.map((item) => {
              const progress = item.progressTotal
                ? Math.min(100, Math.round(((item.progressCurrent || 0) / item.progressTotal) * 100))
                : null;
              return (
                <div key={item.id} className="rounded bg-app-hover p-2 text-[11px] text-tx-secondary">
                  <span className="font-mono">{item.actionId}</span> · {item.status} · {item.durationMs ?? "—"}ms
                  {progress !== null && (
                    <div className="mt-1">
                      <div className="h-1.5 overflow-hidden rounded bg-app-border">
                        <div className="h-full bg-accent-primary" style={{ width: `${progress}%` }} />
                      </div>
                      <div className="mt-1 text-tx-tertiary">{item.progressMessage || `${item.progressCurrent || 0} / ${item.progressTotal}`}</div>
                    </div>
                  )}
                  {item.errorMessage && <div className="mt-1 text-red-600">{item.errorMessage}</div>}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-tx-tertiary">暂无执行记录</p>
        )}
      </div>
    </div>
  );
}
