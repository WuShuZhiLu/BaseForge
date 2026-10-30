/**
 * 版本历史设置（服务端全局 KV）
 *
 * 存储位置：system_settings 表（server_instance_id 同一张 KV 表），
 * key = version_history_settings，值为 JSON：
 * {
 *   "autoVersionIntervalMinutes": 30,
 *   "sessionEndSnapshot": true,
 *   "retention": { "mode": "forever", "count": 50, "days": 90 }
 * }
 * 默认 mode='forever'（不清理）；count/days 仅为预设参数值。
 */

import { systemSettingsRepository } from "../repositories";

export const VERSION_HISTORY_SETTINGS_KEY = "version_history_settings";

export interface VersionHistoryRetentionSettings {
  mode: "forever" | "count" | "days";
  count: number;
  days: number;
}

export interface VersionHistorySettings {
  autoVersionIntervalMinutes: number;
  sessionEndSnapshot: boolean;
  /** auto（定时快照）保留策略 */
  retention: VersionHistoryRetentionSettings;
  /** manual（Ctrl+S 保存记录）保留策略（v134）：release 永不参与清理 */
  manualRetention: VersionHistoryRetentionSettings;
  /** P2 存储配额（MB）：auto 版本总字节超过该值时按最旧优先清理；0 = 不限制 */
  storageQuotaMb: number;
}

export const DEFAULT_VERSION_HISTORY_SETTINGS: VersionHistorySettings = {
  autoVersionIntervalMinutes: 30,
  sessionEndSnapshot: true,
  retention: { mode: "forever", count: 50, days: 90 },
  manualRetention: { mode: "forever", count: 100, days: 180 },
  storageQuotaMb: 0,
};

const RETENTION_MODES: VersionHistoryRetentionSettings["mode"][] = ["forever", "count", "days"];

/** 间隔分钟数：夹取到 [5, 60] 的整数（UI 档位 5/10/15/30/60）。 */
function sanitizeInterval(raw: unknown): number {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value)) return DEFAULT_VERSION_HISTORY_SETTINGS.autoVersionIntervalMinutes;
  return Math.min(60, Math.max(5, value));
}

function sanitizePositiveInt(raw: unknown, fallback: number): number {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(100000, value);
}

function sanitizeSessionFlag(raw: unknown): boolean {
  if (raw === false || raw === "false") return false;
  return true;
}

/** 配额 MB：非负整数，0 = 不限制；上限 1TB（1024*1024 MB）防误填 */
function sanitizeQuotaMb(raw: unknown): number {
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value) || value < 0) return DEFAULT_VERSION_HISTORY_SETTINGS.storageQuotaMb;
  return Math.min(1024 * 1024, value);
}

function sanitizeRetention(raw: unknown): VersionHistoryRetentionSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = RETENTION_MODES.includes(source.mode as VersionHistoryRetentionSettings["mode"])
    ? (source.mode as VersionHistoryRetentionSettings["mode"])
    : DEFAULT_VERSION_HISTORY_SETTINGS.retention.mode;
  return {
    mode,
    count: sanitizePositiveInt(source.count, DEFAULT_VERSION_HISTORY_SETTINGS.retention.count),
    days: sanitizePositiveInt(source.days, DEFAULT_VERSION_HISTORY_SETTINGS.retention.days),
  };
}

function sanitize(raw: unknown): VersionHistorySettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    autoVersionIntervalMinutes: sanitizeInterval(source.autoVersionIntervalMinutes),
    sessionEndSnapshot: sanitizeSessionFlag(source.sessionEndSnapshot),
    retention: sanitizeRetention(source.retention),
    manualRetention: sanitizeRetention(source.manualRetention),
    storageQuotaMb: sanitizeQuotaMb(source.storageQuotaMb),
  };
}

/** 读取设置；KV 缺失或值损坏时返回默认值（不写回）。 */
export function readVersionHistorySettings(): VersionHistorySettings {
  try {
    const row = systemSettingsRepository.get(VERSION_HISTORY_SETTINGS_KEY);
    if (!row || !row.value) {
      return {
        ...DEFAULT_VERSION_HISTORY_SETTINGS,
        retention: { ...DEFAULT_VERSION_HISTORY_SETTINGS.retention },
      };
    }
    const parsed = JSON.parse(row.value) as unknown;
    return sanitize({ ...DEFAULT_VERSION_HISTORY_SETTINGS, ...(typeof parsed === "object" && parsed !== null ? parsed : {}) });
  } catch (error) {
    console.warn(
      "[version-history-settings] read failed, using defaults:",
      error instanceof Error ? error.message : error,
    );
    return {
      ...DEFAULT_VERSION_HISTORY_SETTINGS,
      retention: { ...DEFAULT_VERSION_HISTORY_SETTINGS.retention },
    };
  }
}

/** 局部更新（未提供的键保持现值）并持久化，返回合并后的完整设置。 */
export function writeVersionHistorySettings(patch: unknown): VersionHistorySettings {
  const current = readVersionHistorySettings();
  const source = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const patchRetention = (source.retention && typeof source.retention === "object" ? source.retention : {}) as Record<string, unknown>;
  const patchManualRetention = (source.manualRetention && typeof source.manualRetention === "object" ? source.manualRetention : {}) as Record<string, unknown>;
  const merged = sanitize({
    autoVersionIntervalMinutes:
      source.autoVersionIntervalMinutes !== undefined
        ? source.autoVersionIntervalMinutes
        : current.autoVersionIntervalMinutes,
    sessionEndSnapshot:
      source.sessionEndSnapshot !== undefined ? source.sessionEndSnapshot : current.sessionEndSnapshot,
    storageQuotaMb:
      source.storageQuotaMb !== undefined ? source.storageQuotaMb : current.storageQuotaMb,
    retention: {
      mode: patchRetention.mode !== undefined ? patchRetention.mode : current.retention.mode,
      count: patchRetention.count !== undefined ? patchRetention.count : current.retention.count,
      days: patchRetention.days !== undefined ? patchRetention.days : current.retention.days,
    },
    manualRetention: {
      mode: patchManualRetention.mode !== undefined ? patchManualRetention.mode : current.manualRetention.mode,
      count: patchManualRetention.count !== undefined ? patchManualRetention.count : current.manualRetention.count,
      days: patchManualRetention.days !== undefined ? patchManualRetention.days : current.manualRetention.days,
    },
  });
  systemSettingsRepository.set(VERSION_HISTORY_SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}
