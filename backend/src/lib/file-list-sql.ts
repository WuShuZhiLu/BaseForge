/**
 * /api/files 列表共用的 SQL 片段
 * ---------------------------------------------------------------------------
 * 同一个列表查询在三层各写了一遍：原始路由（routes/files.ts）→ 知识树可见
 * 性收口（middleware/knowledgeFilesCapabilityGuard.ts，它重建整个响应）→ 孤儿
 * 即时视图（runtime/file-orphan-visibility.ts）。筛选/排序口径只要有一层漏掉，
 * 前端拿到的就是“参数发了但没生效”（已实测到：侧栏选“视频”仍旧返回全部附件）。
 *
 * 两个 runtime 层从这里取片段；routes/files.ts 目前保留等价的本地实现，
 * 改口径时三处都要过一遍。
 */

/**
 * 把前端传来的 sort 参数归一化为 SQL ORDER BY 片段。
 * 只接受白名单字段，避免 SQL 注入；未知值落回默认。
 */
export function resolveFileListOrderBy(sort: string | undefined): string {
  switch ((sort || "").toLowerCase()) {
    case "name_asc":
      return "a.filename COLLATE NOCASE ASC";
    case "name_desc":
      return "a.filename COLLATE NOCASE DESC";
    case "size_asc":
      return "a.size ASC";
    case "size_desc":
      return "a.size DESC";
    case "created_asc":
      return "a.createdAt ASC";
    case "referenced_desc":
      // “最近引用”：取引用该附件的最新一条 attachment_references.createdAt。
      // 子查询写两遍是为了先按“有无引用”分组（IS NULL 为 0/1），让从未被引用的
      // 附件沉到末尾——SQLite 的 NULLS LAST 语法要 3.30+，用 IS NULL 更兼容。
      // 语义注意：倒排表记录的是“引用关系建立时间”，笔记反复编辑不会刷新它。
      //
      // 末尾的 a.createdAt DESC, a.id ASC 是必要的决胜位：倒排表是写时维护的
      // （历史库没有 backfill），大批附件的 MAX(createdAt) 会同时为 NULL；没有
      // 决胜位时这些行的顺序不确定，翻页会出现重复/漏项。加上之后老库的
      // “最近引用”自然退化为“最新上传”，语义仍然合理。
      return `(
        SELECT MAX(ar0.createdAt) FROM attachment_references ar0 WHERE ar0.attachmentId = a.id
      ) IS NULL,
      (
        SELECT MAX(ar1.createdAt) FROM attachment_references ar1 WHERE ar1.attachmentId = a.id
      ) DESC, a.createdAt DESC, a.id ASC`;
    case "created_desc":
    default:
      return "a.createdAt DESC";
  }
}

/**
 * “已分享 / 未分享”筛选片段。
 * EXISTS 子查询走 idx_attachment_shares_attachment，不扫全表。
 * 过期分享不算：isActive=1 且未过 expiresAt 才计作“已分享”。
 */
export function buildShareStatusWhere(
  status: "shared" | "unshared",
  alias = "a",
): string {
  const existsSql = `EXISTS(SELECT 1 FROM attachment_shares s
      WHERE s.attachmentId = ${alias}.id AND s.isActive = 1
        AND (s.expiresAt IS NULL OR s.expiresAt > datetime('now')))`;
  return status === "shared" ? existsSql : `NOT ${existsSql}`;
}

/**
 * 关键字搜索：文件名或 MIME 类型任一命中。
 * 统一搜索框输 "pdf" / "video/" 也能命中，避免用户为了按类型找文件
 * 还得先去学侧栏的精确 MIME 筛选。
 */
export function buildKeywordWhere(alias = "a"): string {
  return `(${alias}.filename LIKE ? COLLATE NOCASE OR ${alias}.mimeType LIKE ? COLLATE NOCASE)`;
}

/**
 * 把 id 集合落成 IN 条件；空集必须是 `1 = 0` 而不是省略条件，
 * 否则筛选静默失效、返回 scope 全集（历史血泪：filter 大小写写错时就是这样）。
 */
export function appendIdSetWhere(
  where: string[],
  params: Array<string | number>,
  ids: Iterable<string>,
): void {
  const list = Array.from(ids);
  if (list.length === 0) {
    where.push("1 = 0");
    return;
  }
  where.push(`a.id IN (${list.map(() => "?").join(",")})`);
  params.push(...list);
}
