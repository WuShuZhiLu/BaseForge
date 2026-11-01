/**
 * 分享默认值（唯一的口径来源）
 * ---------------------------------------------------------------------------
 * 历史上笔记分享与附件分享的 expiresAt 都允许留空＝永久，批量「生成公开链接」
 * 更是直接 `open(id, {})`，一次造出 N 条无密码 + 永久 + 不限次的公开链。
 * 现在把「7 天」作为新建分享的默认有效期，永久必须显式选择。
 */
export const SHARE_DEFAULT_EXPIRY_DAYS = 7;

export const DAY_MS = 86_400_000;

/** 新建分享的默认过期时间（ISO 字符串，带 Z，与现有 Date.parse 判定一致）。 */
export function defaultShareExpiresAt(nowMs: number = Date.now()): string {
  return new Date(nowMs + SHARE_DEFAULT_EXPIRY_DAYS * DAY_MS).toISOString();
}
