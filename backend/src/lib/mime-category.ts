/**
 * MIME 大类分类（文件管理「统一文件池」的类型维度）
 * ---------------------------------------------------------------------------
 * 文件管理不再按「附件 / 图床」两个来源分隔，所有附件进入同一个文件池；
 * 文件类型（图片 / 视频 / 音频 / 文档 / 其他）降级为**筛选维度**，
 * 通过 `GET /api/files?mimeCategory=video` 收口。
 *
 * 两份实现必须保持等价：
 *   1) getMimeCategory()：JS 侧分类。用于 /api/files/stats 聚合，以及列表响应里
 *      给前端下发 mimeCategory 字段（前端不必再维护一份同样的白名单）；
 *   2) buildMimeCategoryWhere()：SQL 侧等价条件。SQLite 不支持在 WHERE 里调用
 *      JS 函数，只能把分类翻译成 LIKE / IN 条件。
 *
 * 判定顺序（先具体后兜底）：image → video → audio → doc → other。
 * 五个集合都是小写；入参统一 toLowerCase，与 SQLite `LIKE` 的 ASCII 大小写
 * 不敏感行为对齐（MIME 本身按规范就是小写）。
 */

export type MimeCategory = "image" | "video" | "audio" | "doc" | "other";

export const MIME_CATEGORIES: readonly MimeCategory[] = [
  "image",
  "video",
  "audio",
  "doc",
  "other",
] as const;

/** 校验外部传入的 mimeCategory 是否合法（非法值按"不筛选"处理）。 */
export function isMimeCategory(value: unknown): value is MimeCategory {
  return typeof value === "string" && (MIME_CATEGORIES as readonly string[]).includes(value);
}

/** 图片：MIME 白名单（前端图片类型图标 / 缩略图能力的交集）。 */
const IMAGE_MIMES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/bmp",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/tiff",
];

/** 视频：常见容器 + 前缀兜底（video/* 一律归视频）。 */
const VIDEO_MIMES: readonly string[] = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/ogg",
  "video/x-msvideo",
  "video/x-matroska",
];

/** 音频：常见编码 + 前缀兜底（audio/* 一律归音频）。 */
const AUDIO_MIMES: readonly string[] = [
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/opus",
  "audio/amr",
  "audio/x-m4a",
];

/**
 * 文档：办公文档 / PDF / 文本 / 压缩包 / 结构化数据。
 * text/* 前缀也算文档（见下方兜底），这里列出的非 text/* 项必须显式写全，
 * 否则会落进 other。
 */
const DOC_MIMES: readonly string[] = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/markdown",
  "text/plain",
  "text/html",
  "text/csv",
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  "application/json",
  "application/xml",
];

const IMAGE_SET = new Set(IMAGE_MIMES);
const VIDEO_SET = new Set(VIDEO_MIMES);
const AUDIO_SET = new Set(AUDIO_MIMES);
const DOC_SET = new Set(DOC_MIMES);

/** 把 MIME 归类到五个大类之一；空值归 other（历史行 mimeType 可能为 NULL）。 */
export function getMimeCategory(mime: string | null | undefined): MimeCategory {
  if (!mime) return "other";
  const lower = mime.toLowerCase();
  if (IMAGE_SET.has(lower)) return "image";
  if (VIDEO_SET.has(lower)) return "video";
  if (AUDIO_SET.has(lower)) return "audio";
  if (DOC_SET.has(lower)) return "doc";
  // 前缀兜底：白名单外的衍生 MIME（如 image/jxl、application/vnd.*.macroEnabled）
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("audio/")) return "audio";
  if (lower.startsWith("text/")) return "doc";
  return "other";
}

/**
 * 把 MIME 大类翻译成 SQL WHERE 条件（与 getMimeCategory 等价）。
 *
 * @param mimeCategory 五个大类之一
 * @param column mimeType 所在列（默认文件管理列表的别名 `a.mimeType`）
 * @returns sql 片段 + 需要追加到参数列表的占位符实参
 */
export function buildMimeCategoryWhere(
  mimeCategory: MimeCategory,
  column = "a.mimeType",
): { sql: string; params: string[] } {
  switch (mimeCategory) {
    case "image":
    case "video":
    case "audio":
      return { sql: `${column} LIKE '${mimeCategory}/%'`, params: [] };
    case "doc":
      return {
        sql: `(${column} LIKE 'text/%' OR ${column} IN (${DOC_MIMES.map(() => "?").join(",")}))`,
        params: [...DOC_MIMES],
      };
    case "other":
      // 不落在前四类里的（含 mimeType 为 NULL 的历史行）。
      return {
        sql:
          `(${column} IS NULL OR (` +
          `${column} NOT LIKE 'image/%' AND ${column} NOT LIKE 'video/%' AND ` +
          `${column} NOT LIKE 'audio/%' AND ${column} NOT LIKE 'text/%' AND ` +
          `${column} NOT IN (${DOC_MIMES.map(() => "?").join(",")})))`,
        params: [...DOC_MIMES],
      };
  }
}
