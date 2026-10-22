/**
 * 版本历史 v2：会话结束快照 helper。
 *
 * 职责（VERSION_V2_BRIEF「前端要点补充」）：
 * 1. 读取 versionHistory 设置（GET /api/settings 合并下发 versionHistory 字段），带 TTL 缓存；
 * 2. 编辑器切走/卸载且 sessionEndSnapshot 开启时，调用 POST .../versions/snapshot
 *    触发一次 auto 快照 —— fire-and-forget：不 await、不弹 toast、失败静默。
 *    快照端点本身幂等（内容 hash 未变返回 created:false），重复触发无副作用。
 */
import { api } from "@/lib/api";
import type { VersionHistorySettings, VersionRetentionConfig } from "@/types";

/** 与后端契约一致的默认值；请求失败时兜底（interval=30、sessionEndSnapshot=true、retention.mode='forever'）。 */
export const VERSION_HISTORY_DEFAULTS: VersionHistorySettings = {
  autoVersionIntervalMinutes: 30,
  sessionEndSnapshot: true,
  retention: { mode: "forever", count: 50, days: 90 },
  storageQuotaMb: 0,
};

const SETTINGS_TTL_MS = 60_000;

let settingsCache: { value: VersionHistorySettings; fetchedAt: number } | null = null;
let settingsInflight: Promise<VersionHistorySettings> | null = null;

/** 容错归一化：后端/缓存数据缺字段时回落默认值，保证调用方拿到完整形状。 */
function normalizeVersionHistorySettings(raw: unknown): VersionHistorySettings {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<VersionHistorySettings>;
  const rawRetention = (src.retention && typeof src.retention === "object" ? src.retention : {}) as Partial<VersionRetentionConfig>;
  const mode = rawRetention.mode === "count" || rawRetention.mode === "days" ? rawRetention.mode : "forever";
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
 * 会话结束快照：sessionEndSnapshot 开启时对 noteId 发一次 auto 快照。
 * fire-and-forget：内部延迟 2s 触发，给切走前的 flushSave PUT 留出落盘时间；
 * 任何失败都静默（console.warn 即可，不打扰用户）。
 */
export function maybeSnapshotOnEditorLeave(noteId: string | null | undefined): void {
  if (!noteId) return;
  void getVersionHistorySettings()
    .then((settings) => {
      if (!settings.sessionEndSnapshot) return;
      window.setTimeout(() => {
        api.snapshotNoteVersion(noteId).catch((e) => {
          console.warn("[versionSnapshot] session-end snapshot failed:", e);
        });
      }, 2000);
    })
    .catch(() => {
      /* 静默：会话结束快照不允许打扰用户 */
    });
}
