import type { DatabaseSync } from "node:sqlite";
import { markBlockAuthorityMismatch, rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore";
import { syncNoteBlocks } from "../lib/noteBlocks";

interface RecoveredNoteRow {
  id: string;
  content: string;
  contentText: string;
  contentFormat: string;
  version: number;
}

/**
 * 旧数据的格式自检：声明 tiptap-json、内容却是 HTML/Markdown。
 *
 * nowen 早期版本有整批笔记把 HTML 直接存进 notes.content，而 contentFormat 取了列
 * 默认值 'tiptap-json'（用户 2026-10-27 的整库导出包里 56 篇有 52 篇是这种）。按声明
 * 格式 JSON.parse 必然失败，导入后每篇都会被标成 block 权威 mismatch。
 *
 * 这里只用于「解析 block」的格式判定，不回写 notes.contentFormat：前端 TipTap 的
 * setContent 能直接吃 HTML 字符串，用户打开编辑、首次保存后内容自然变成合法 tiptap
 * JSON，格式也就自愈了；反过来若改成 html 会让这些笔记退化成只读预览。
 */
function resolveBlockParseFormat(content: string, declared: string): string {
  if (declared !== "tiptap-json") return declared;
  const head = content.trimStart().slice(0, 1);
  if (head === "{" || head === "[") return declared;
  return head === "<" ? "html" : "markdown";
}

export interface BlockAuthorityRecoveryResult {
  synchronized: number;
  skipped: string[];
  failures: Array<{ noteId: string; error: string }>;
}

/**
 * 恢复或导入完成后逐笔记重建 Block 权威状态。
 * 单笔失败保留 notes.content，并标记已有 shadow 为 mismatch，不影响同批其他笔记。
 *
 * 事务用 SAVEPOINT 而非 db.transaction()：本函数会被「导入」直接调用，而导入
 * 自己握着一个大事务（BEGIN...COMMIT），嵌套 BEGIN 在 node:sqlite 下会抛
 * `cannot start a transaction within a transaction`——曾经的后果是每篇笔记都
 * 走到 markBlockAuthorityMismatch，导入后全库 block 权威状态被标脏。
 * SAVEPOINT 在事务内外都能用：事务内是嵌套子事务，事务外等价于独立事务。
 */
export function synchronizeRecoveredBlockAuthority(
  db: DatabaseSync,
  noteIds: Iterable<string>,
): BlockAuthorityRecoveryResult {
  const skipped: string[] = [];
  const failures: Array<{ noteId: string; error: string }> = [];
  let synchronized = 0;

  for (const noteId of new Set(noteIds)) {
    const note = db.prepare(`
      SELECT id, content, contentText, contentFormat, version FROM notes WHERE id = ?
    `).get(noteId) as RecoveredNoteRow | undefined;
    if (!note || !["tiptap-json", "markdown"].includes(note.contentFormat)) {
      skipped.push(noteId);
      continue;
    }

    try {
      const parseFormat = resolveBlockParseFormat(note.content, note.contentFormat);
      db.transaction(() => {
        const synced = syncNoteBlocks(db, note.id, note.content, parseFormat);
        // contentText 是全派生字段（搜索、列表摘要都读它）；导入包里的旧数据可能
        // 根本没带文本（用户 2026-10-27 那份包 56 篇里 52 篇 contentText 为空，
        // 直接落库等于搜不到）。派生成功就写回，保持它与 content 一致。
        if (synced.contentText && synced.contentText !== (note.contentText ?? "")) {
          db.prepare("UPDATE notes SET contentText = ? WHERE id = ?").run(synced.contentText, note.id);
        }
        // 物化 block 权威存储只认 tiptap-json / markdown；html 内容（含下面那种
        // 「声明 tiptap-json 实际是 HTML」的旧数据）只派生 contentText，不建 shadow。
        if (parseFormat === "tiptap-json" || parseFormat === "markdown") {
          rebuildBlockAuthorityStore(db, note.id, synced.content, parseFormat, {
            noteVersion: note.version,
            operationType: "recovery-sync",
            operationJson: { source: "recovery" },
          });
        }
      })();
      synchronized += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markBlockAuthorityMismatch(db, note.id, `recovery:${message}`);
      failures.push({ noteId: note.id, error: message });
    }
  }

  return { synchronized, skipped, failures };
}
