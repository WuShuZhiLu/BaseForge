import type { Migration } from "./migrations.impl.js";

export const MARKDOWN_DEFAULT_PREVIEW_SCHEMA_VERSION = 133;

/**
 * Markdown 默认打开方式：把历史默认值 source 迁移为 preview。
 *
 * 背景：产品要求「Markdown 文档默认预览」。前端默认值已改为 preview，但老账号的
 * user_preferences.preferencesJson 里早就写入了 markdownDefaultViewMode="source"
 * （旧版本的默认值），它优先于代码默认值，导致设置里看起来没生效、打开仍是源码。
 *
 * 取舍：这会覆盖"当年没有主动改过、被旧默认写进去"的 source；用户在设置里仍可
 * 改回源码。只改这一条键，其它偏好原样保留。
 */
export const markdownDefaultPreviewMigration: Migration = {
  version: MARKDOWN_DEFAULT_PREVIEW_SCHEMA_VERSION,
  name: "markdown-default-preview",
  up: (db) => {
    const rows = db
      .prepare("SELECT userId, preferencesJson FROM user_preferences")
      .all() as Array<{ userId: string; preferencesJson: string | null }>;
    if (rows.length === 0) return;
    const update = db.prepare("UPDATE user_preferences SET preferencesJson = ? WHERE userId = ?");
    for (const row of rows) {
      try {
        const prefs = JSON.parse(row.preferencesJson || "{}") as Record<string, unknown>;
        if (prefs.markdownDefaultViewMode !== "source") continue;
        prefs.markdownDefaultViewMode = "preview";
        update.run(JSON.stringify(prefs), row.userId);
      } catch {
        // 单行 JSON 损坏不阻断迁移
      }
    }
  },
};
