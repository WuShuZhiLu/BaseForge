/**
 * 版本记录触发（收敛后仅三种入口产生版本记录）：
 *
 * 1. 用户点击顶栏「已同步」按钮（手动同步）→ recordManualNoteSave（source=manual）
 * 2. Ctrl+S / Cmd+S → recordManualNoteSave（source=manual）
 * 3. 定时保存 → startVersionAutoSaveTimer：间隔读用户偏好 versionAutoSaveIntervalMinutes
 *    （默认 5 分钟），到点先 flush 待存编辑再调快照端点（source=auto）
 *
 * 普通的防抖自动保存（PUT /notes）不产生版本记录。所有入口共用后端的
 * 「内容与最近一条版本一致则不落」幂等规则（recordNoteSave）。
 *
 * 另保留 versionHistory 设置读取（GET /api/settings 合并下发 versionHistory 字段，
 * 带 TTL 缓存），供保留策略/设置页使用。
 */
import { api, getBaseUrl } from "@/lib/api";
import type { VersionHistorySettings, VersionRetentionConfig } from "@/types";

/** 与后端契约一致的默认值；请求失败时兜底（interval=30、sessionEndSnapshot=true、retention/manualRetention=forever）。 */
export const VERSION_HISTORY_DEFAULTS: VersionHistorySettings = {
  autoVersionIntervalMinutes: 30,
  sessionEndSnapshot: true,
  retention: { mode: "forever", count: 50, days: 90 },
  manualRetention: { mode: "forever", count: 100, days: 180 },
  storageQuotaMb: 0,
};

const SETTINGS_TTL_MS = 60_000;

let settingsCache: { value: VersionHistorySettings; fetchedAt: number } | null = null;
let settingsInflight: Promise<VersionHistorySettings> | null = null;

/** 容错归一化：后端/缓存数据缺字段时回落默认值，保证调用方拿到完整形状。 */
function normalizeVersionHistorySettings(raw: unknown): VersionHistorySettings {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<VersionHistorySettings>;
  const rawRetention = (src.retention && typeof src.retention === "object" ? src.retention : {}) as Partial<VersionRetentionConfig>;
  const rawManualRetention = (src.manualRetention && typeof src.manualRetention === "object" ? src.manualRetention : {}) as Partial<VersionRetentionConfig>;
  const mode = rawRetention.mode === "count" || rawRetention.mode === "days" ? rawRetention.mode : "forever";
  const manualMode = rawManualRetention.mode === "count" || rawManualRetention.mode === "days" ? rawManualRetention.mode : "forever";
  return {
    autoVersionIntervalMinutes: Number.isFinite(src.autoVersionIntervalMinutes)
      ? Number(src.autoVersionIntervalMinutes)
      : VERSION_HISTORY_DEFAULTS.autoVersionIntervalMinutes,
    sessionEndSnapshot: typeof src.sessionEndSnapshot === "boolean"
      ? src.sessionEndSnapshot
      : VERSION_HISTORY_DEFAULTS.sessionEndSnapshot,
    retention: {
      mode,
      count: Number.isFinite(rawRetention.count) ? Number(rawRetention.count) : VERSION_HISTORY_DEFAULTS.retention.count,
      days: Number.isFinite(rawRetention.days) ? Number(rawRetention.days) : VERSION_HISTORY_DEFAULTS.retention.days,
    },
    manualRetention: {
      mode: manualMode,
      count: Number.isFinite(rawManualRetention.count) ? Number(rawManualRetention.count) : VERSION_HISTORY_DEFAULTS.manualRetention.count,
      days: Number.isFinite(rawManualRetention.days) ? Number(rawManualRetention.days) : VERSION_HISTORY_DEFAULTS.manualRetention.days,
    },
    storageQuotaMb: Number.isFinite(src.storageQuotaMb) ? Number(src.storageQuotaMb) : VERSION_HISTORY_DEFAULTS.storageQuotaMb,
  };
}

/** 读取版本历史设置（TTL 缓存 + 并发去重；失败时回落默认值并清缓存以便下次重试）。 */
export async function getVersionHistorySettings(): Promise<VersionHistorySettings> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.fetchedAt < SETTINGS_TTL_MS) return settingsCache.value;
  if (!settingsInflight) {
    settingsInflight = api
      .getVersionHistorySettings()
      .then((res) => {
        const value = normalizeVersionHistorySettings(res?.versionHistory);
        settingsCache = { value, fetchedAt: Date.now() };
        return value;
      })
      .catch((e) => {
        console.warn("[versionSnapshot] load settings failed, fallback to defaults:", e);
        settingsCache = null;
        return VERSION_HISTORY_DEFAULTS;
      })
      .finally(() => {
        settingsInflight = null;
      });
  }
  return settingsInflight;
}

/** 设置保存成功后写入本地缓存，避免 TTL 窗口内（含会话结束快照判断）读到旧值。 */
export function primeVersionHistorySettingsCache(value: VersionHistorySettings): void {
  settingsCache = { value: normalizeVersionHistorySettings(value), fetchedAt: Date.now() };
}

/**
 * 会话结束快照已移除：编辑器切走/卸载不再产生版本记录（不属于三种合法入口）。
 */

// ---------------------------------------------------------------------------
// 入口②：Ctrl+S / 顶栏「已同步」手动保存 → 落 manual 版本记录
// ---------------------------------------------------------------------------

/**
 * 手动保存落版本记录：POST /shares/note/:noteId/versions/save（后端固定 source=manual）。
 * 后端幂等：当前内容与最近一条版本记录 hash 一致时返回 created:false，不落记录。
 * 走独立 fetch（同 aiProfiles 模式）：版本记录是旁路动作，不进离线队列、失败由调用方静默。
 */
/** 顶栏「版本 N」的数据源是版本记录号：任何入口落了新记录就广播，EditorPane 收到后刷新显示。 */
export const VERSION_RECORD_CREATED_EVENT = "nowen:version-record-created";
export function emitVersionRecordCreated(noteId: string, version: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(VERSION_RECORD_CREATED_EVENT, { detail: { noteId, version } }));
}

export async function recordManualNoteSave(noteId: string): Promise<{ created: boolean; version?: number }> {
  const token = localStorage.getItem("nowen-token") || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${getBaseUrl()}/shares/note/${encodeURIComponent(noteId)}/versions/save`, {
    method: "POST",
    headers,
    body: "{}",
  });
  const body = await response.json().catch(() => ({})) as { created?: boolean; version?: { version?: number } } | null;
  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error || `Request failed: ${response.status}`);
  }
  const version = body?.version?.version;
  const created = Boolean(body?.created);
  if (created && typeof version === "number") emitVersionRecordCreated(noteId, version);
  return { created, version };
}

// ---------------------------------------------------------------------------
// 入口③：定时保存（间隔 = 用户偏好 versionAutoSaveIntervalMinutes，默认 5 分钟）
// ---------------------------------------------------------------------------

export const DEFAULT_VERSION_AUTO_SAVE_INTERVAL_MINUTES = 5;
const MIN_AUTO_SAVE_INTERVAL_MINUTES = 1;
const MAX_AUTO_SAVE_INTERVAL_MINUTES = 120;

/** 偏好项 key：user_preferences 机制（UI 后续接入；读取失败/未设置时用默认值）。 */
const AUTO_SAVE_INTERVAL_PREFERENCE_KEY = "versionAutoSaveIntervalMinutes";

let intervalPrefCache: { value: number; fetchedAt: number } | null = null;

/**
 * 读取定时保存间隔（分钟）。TTL 缓存 60s，改偏好后最迟一个缓存周期生效。
 * 偏好未设置/非法或请求失败时回落默认值（失败不缓存，下一轮重试）。
 */
export async function getVersionAutoSaveIntervalMinutes(): Promise<number> {
  const now = Date.now();
  if (intervalPrefCache && now - intervalPrefCache.fetchedAt < SETTINGS_TTL_MS) return intervalPrefCache.value;
  try {
    const raw = (await api.getUserPreferences()) as Record<string, unknown> | null;
    const parsed = Math.round(Number(raw?.[AUTO_SAVE_INTERVAL_PREFERENCE_KEY]));
    const value = Number.isFinite(parsed) && parsed >= MIN_AUTO_SAVE_INTERVAL_MINUTES
      ? Math.min(parsed, MAX_AUTO_SAVE_INTERVAL_MINUTES)
      : DEFAULT_VERSION_AUTO_SAVE_INTERVAL_MINUTES;
    intervalPrefCache = { value, fetchedAt: now };
    return value;
  } catch (error) {
    console.warn("[versionSnapshot] read auto-save interval failed, use default:", error);
    intervalPrefCache = null;
    return DEFAULT_VERSION_AUTO_SAVE_INTERVAL_MINUTES;
  }
}

export interface VersionAutoSaveTimerOptions {
  /** 当前激活文档 id；返回 null/undefined（无激活文档）时本轮跳过。 */
  getActiveNoteId: () => string | null | undefined;
  /**
   * 快照前把编辑器 pending 的防抖编辑 flush 成 PUT；resolve false（离线/保存失败）
   * 时跳过本轮快照（服务端内容未变，快照本身也会幂等跳过，跳过只是省一次请求）。
   */
  flushPendingSave: () => Promise<boolean>;
}

/**
 * 定时保存计时器：每轮先睡 interval 分钟，到点 flush 待存编辑后调快照端点
 * （POST .../versions/snapshot，source=auto；内容无变化时后端返回 created:false）。
 * 间隔每轮重新读取，用户改偏好后下一轮生效。返回 stop 函数供组件卸载清理。
 */
export function startVersionAutoSaveTimer(options: VersionAutoSaveTimerOptions): () => void {
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    handle = setTimeout(() => { void runRound(); }, delayMs);
  };

  const runRound = async () => {
    if (stopped) return;
    try {
      if (typeof navigator === "undefined" || navigator.onLine) {
        const noteId = options.getActiveNoteId();
        if (noteId) {
          const flushed = await options.flushPendingSave();
          // flush 期间可能已切走文档/卸载，复查一次再落快照
          const currentId = stopped ? null : options.getActiveNoteId();
          if (flushed && currentId === noteId) {
            const result = await api.snapshotNoteVersion(noteId);
            const version = (result as { version?: { version?: number } } | null)?.version?.version;
            if (typeof version === "number") emitVersionRecordCreated(noteId, version);
          }
        }
      }
    } catch (error) {
      // 保存失败/离线/请求失败：静默跳过本轮，不影响下一轮
      console.warn("[versionSnapshot] auto-save round failed:", error);
    }
    const minutes = await getVersionAutoSaveIntervalMinutes();
    schedule(Math.max(MIN_AUTO_SAVE_INTERVAL_MINUTES, minutes) * 60_000);
  };

  void getVersionAutoSaveIntervalMinutes().then((minutes) => {
    schedule(Math.max(MIN_AUTO_SAVE_INTERVAL_MINUTES, minutes) * 60_000);
  });

  return () => {
    stopped = true;
    if (handle !== null) clearTimeout(handle);
    handle = null;
  };
}
