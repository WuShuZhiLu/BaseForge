/**
 * 附件引用扫描（内容口径）
 * ---------------------------------------------------------------------------
 * /api/files 的列表与统计在两个地方都要判断“这个附件有没有被笔记正文引用”：
 *   - routes/files.ts            原始路由（个人/工作区列表 + /stats）
 *   - middleware/knowledgeFilesCapabilityGuard.ts
 *                              知识树可见性收口后的重建列表（实际线上响应来源）
 * 两处必须用同一份判定，否则徽标数与点进去的列表会对不上，所以上提到这里。
 *
 * 扫描产出两个分类：
 *   - referencedIds：`/api/attachments/<id>` 在 scope 内所有 notes.content
 *                    里能扫到的——「文档引用」分类；
 *   - orphanIds    ：attachments 行存在、noteId 对应 note 也存在，但正文里
 *                    扫不到——「未引用」分类。
 *
 * 两个集合严格互补，相加就是全部附件——侧栏两个徽标的数字必须能跟「全部」对上，
 * 否则用户会认为筛选坏了。
 *
 * 这里不带时间宽限期：“未引用”是一个只读浏览分类，刚上传还没插进笔记的文件
 * 本来就应该在里面。24h 宽限只属于真正删文件的 `/api/data-file/cleanup-orphans`
 * （它自带 graceHours，默认 24），也不属于「可回收空间」徽标（走 cleanup dryRun）。
 * 历史教训：宽限期加在浏览分类上，“未引用”会整天空白（刚上传的都满 24h 才出现）。
 *
 * 不能改用 attachment_references 倒排表做“未引用”：那个口径会与“清理孤儿”
 * 按钮实际回收的集合不一致。
 *
 * 性能：一次性把 scope 内的 notes.content 拼成单个 haystack 字符串，再对每个
 * 附件 id 做 `indexOf`。attachments id 是 uuid 不会误匹配。O(M + N*L) 但 L 是
 * 常数级（uuid 长度），大库仍可接受；比每个 id 单独跑一次 LIKE '%..%' 快数百倍。
 * 顺带累加两类的字节数，让 stats 不再为同一批 id 再跑一次 `IN (...)` 聚合。
 */
import type { DatabaseSync } from "node:sqlite";

export interface ReferenceScan {
  orphanIds: Set<string>;
  referencedIds: Set<string>;
  orphanBytes: number;
  referencedBytes: number;
}

export interface ReferenceScanScope {
  scope: "personal" | "workspace";
  workspaceId: string | null;
}

export function scanAttachmentReferences(
  db: DatabaseSync,
  scope: ReferenceScanScope,
  userId: string,
): ReferenceScan {
  const orphanIds = new Set<string>();
  const referencedIds = new Set<string>();
  let orphanBytes = 0;
  let referencedBytes = 0;

  // 1) 拉 scope 内的 haystack（仅 content 非空的 note，减少 join 字符串开销）
  const contentRows = (scope.scope === "workspace"
    ? db
        .prepare(
          `SELECT content FROM notes
            WHERE workspaceId = ? AND content IS NOT NULL AND content <> ''`,
        )
        .all(scope.workspaceId!)
    : db
        .prepare(
          `SELECT content FROM notes
            WHERE userId = ? AND workspaceId IS NULL
              AND content IS NOT NULL AND content <> ''`,
        )
        .all(userId)) as { content: string }[];
  const haystack = contentRows.map((r) => r.content).join("\n");

  // 2) 拉 scope 内的候选附件（只看 noteId 对应 note 还在的那批）
  const candidates = (scope.scope === "workspace"
    ? db
        .prepare(
          `SELECT a.id, a.size FROM attachments a
            INNER JOIN notes n ON n.id = a.noteId
            WHERE a.workspaceId = ?`,
        )
        .all(scope.workspaceId!)
    : db
        .prepare(
          `SELECT a.id, a.size FROM attachments a
            INNER JOIN notes n ON n.id = a.noteId
            WHERE a.userId = ? AND a.workspaceId IS NULL`,
        )
        .all(userId)) as { id: string; size: number }[];

  // 3) 扫描
  // PDF 笔记（contentFormat=pdf）正文是 {"attachmentId":"<uuid>"}，没有 URL 字面量，
  // 单靠 URL 子串匹配会把 PDF 原件误判为孤儿。补一层 attachmentId JSON 匹配。
  const attachmentIdJsonRe = /"attachmentId"\s*:\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/g;
  const jsonReferencedIds = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = attachmentIdJsonRe.exec(haystack)) !== null) {
    jsonReferencedIds.add(m[1].toLowerCase());
  }
  for (const r of candidates) {
    if (haystack.indexOf(`/api/attachments/${r.id}`) >= 0 || jsonReferencedIds.has(r.id.toLowerCase())) {
      referencedIds.add(r.id);
      referencedBytes += r.size || 0;
      continue;
    }
    orphanIds.add(r.id);
    orphanBytes += r.size || 0;
  }
  return { orphanIds, referencedIds, orphanBytes, referencedBytes };
}
