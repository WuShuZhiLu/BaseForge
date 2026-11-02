/**
 * Note Versions Repository
 *
 * 职责：
 * - 封装 note_versions 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 *
 * 注意：
 * - 已迁移：查询类 SQL（B2-B1）、创建版本 INSERT（B2-B2）
 * - 未迁移：删除版本 DELETE / pruneOldVersions / 恢复版本事务
 * - 不涉及 notes 主表 CRUD
 */

import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";
import { extractAttachmentIdsFromContent } from "../lib/attachmentRefs";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

/** 快照来源：auto=定时快照，manual=Ctrl+S 保存，release=用户「保存为版本」 */
export type VersionSource = "auto" | "manual" | "release";

export const VERSION_SOURCES: VersionSource[] = ["auto", "manual", "release"];

/** note_versions 记录（列表视图，不含 content/contentText） */
export interface NoteVersionListItem {
  id: string;
  noteId: string;
  userId: string;
  title: string | null;
  version: number;
  changeType: string;
  changeSummary: string | null;
  createdAt: string;
  username: string | null;
  /** 旧口径列，v134 起与 source 同值（auto|manual|release），供旧客户端兼容 */
  kind: VersionSource;
  /** 版本来源（v134）：auto=定时，manual=Ctrl+S 保存，release=发版 */
  source: VersionSource;
  label: string | null;
  description: string | null;
  contentBytes: number;
}

/** note_versions 完整记录 */
export interface NoteVersionRecord {
  id: string;
  noteId: string;
  userId: string;
  title: string | null;
  content: string | null;
  contentText: string | null;
  contentFormat: string;
  version: number;
  changeType: string;
  changeSummary: string | null;
  createdAt: string;
  kind: VersionSource;
  source: VersionSource;
  label: string | null;
  description: string | null;
  contentHash: string | null;
}

export const noteVersionsRepository = {
  /**
   * 列出某笔记的版本历史（分页）。
   *
   * 保持原 SQL：JOIN users 获取 username，按 version DESC 排序。
   *
   * @param noteId 笔记 ID
   * @param limit 每页条数
   * @param offset 偏移量
   * @returns 版本列表
   */
  listByNoteId(noteId: string, limit: number, offset: number, kind?: VersionSource, source?: VersionSource): NoteVersionListItem[] {
    const db = getDb();
    const kindClause = kind ? " AND nv.kind = ?" : "";
    const sourceClause = source ? " AND nv.source = ?" : "";
    return db
      .prepare(
        `SELECT nv.id, nv."noteId", nv."userId", nv.title, nv.version, nv."changeType", nv."changeSummary", nv."createdAt",
                nv.kind, nv.source, nv.label, nv.description,
                COALESCE(LENGTH(CAST(nv.content AS BLOB)), 0) AS contentBytes,
                u.username
         FROM note_versions nv
         LEFT JOIN users u ON nv."userId" = u.id
         WHERE nv."noteId" = ?${kindClause}${sourceClause}
         ORDER BY nv.version DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...[noteId, ...(kind ? [kind] : []), ...(source ? [source] : []), limit, offset]) as unknown as NoteVersionListItem[];
  },

  /**
   * 统计某笔记的版本总数。
   *
   * @param noteId 笔记 ID
   * @returns 版本总数
   */
  countByNoteId(noteId: string, kind?: VersionSource, source?: VersionSource): number {
    const db = getDb();
    const kindClause = kind ? " AND kind = ?" : "";
    const sourceClause = source ? " AND source = ?" : "";
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM note_versions WHERE "noteId" = ?${kindClause}${sourceClause}`)
      .get(...[noteId, ...(kind ? [kind] : []), ...(source ? [source] : [])]) as { count: number };
    return row.count;
  },

  /**
   * 获取单个版本（按 id + noteId）。
   *
   * 用于查看单个版本和恢复前读取版本。
   *
   * @param id 版本 ID
   * @param noteId 笔记 ID
   * @returns 版本记录，或 undefined
   */
  getByIdAndNoteId(id: string, noteId: string): NoteVersionRecord | undefined {
    const db = getDb();
    return db
      .prepare('SELECT * FROM note_versions WHERE id = ? AND "noteId" = ?')
      .get(id, noteId) as NoteVersionRecord | undefined;
  },

  /**
   * 获取某笔记最近一条 edit 类型版本的 createdAt。
   *
   * 用于 notes.ts 中 5 分钟窗口判断。只迁移 SELECT 查询，
   * 5 分钟窗口判断逻辑仍留在 route。
   *
   * @param noteId 笔记 ID
   * @returns 最近 edit 版本的 createdAt，或 undefined
   */
  getLastEditByNoteId(noteId: string): { createdAt: string } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT "createdAt" FROM note_versions
         WHERE "noteId" = ? AND "changeType" = 'edit'
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get(noteId) as { createdAt: string } | undefined;
  },

  /**
   * 创建版本记录。
   *
   * 用于：
   * - 编辑保存时记录修改前状态（changeType='edit'）
   * - 访客编辑时记录修改前状态（changeType='guest_edit'）
   * - 恢复版本前备份当前状态（changeType='restore'）
   *
   * @param input 版本数据
   */
  create(input: {
    id: string;
    noteId: string;
    userId: string;
    title: string;
    content: string;
    contentText: string;
    contentFormat?: string;
    version: number;
    changeType: 'edit' | 'guest_edit' | 'restore';
    changeSummary?: string;
    /** 仅在用户迁移导入时传入，保留原始时间戳；不传则由 DB 默认值决定 */
    createdAt?: string;
  }): void {
    const db = getDb();
    const hasChangeSummary = input.changeSummary !== undefined;
    const hasCreatedAt = input.createdAt !== undefined;
    const contentFormat = input.contentFormat || "tiptap-json";

    if (hasChangeSummary && hasCreatedAt) {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType", "changeSummary", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, contentFormat, input.version, input.changeType, input.changeSummary, input.createdAt);
    } else if (hasChangeSummary) {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType", "changeSummary")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, contentFormat, input.version, input.changeType, input.changeSummary);
    } else if (hasCreatedAt) {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, contentFormat, input.version, input.changeType, input.createdAt);
    } else {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.noteId, input.userId, input.title, input.content, input.contentText, contentFormat, input.version, input.changeType);
    }
  },

  /**
   * 删除某笔记的全部版本历史。
   *
   * 用于清空某笔记的版本历史。
   *
   * @param noteId 笔记 ID
   * @returns 删除的行数
   */
  deleteByNoteId(noteId: string): number {
    const db = getDb();
    const result = db.prepare('DELETE FROM note_versions WHERE "noteId" = ?').run(noteId);
    return result.changes as number;
  },

  /**
   * 清理旧版本（保留最近 N 条 + M 天内的全部条目）。
   *
   * 策略：
   * - 只删 changeType = 'edit' 的版本
   * - 保留最近 keepRecent 条
   * - 保留 createdAt 在 keepDays 天内的全部条目
   * - 使用关联子查询定位每篇笔记的 top-N
   *
   * @param keepRecent 保留最近条数
   * @param keepDays 保留天数
   * @returns 删除的行数
   */
  pruneOldVersions(keepRecent: number, keepDays: number): number {
    const db = getDb();
    const cutoff = `datetime('now', '-${keepDays} days')`;
    const result = db.prepare(`
      DELETE FROM note_versions
      WHERE "changeType" = 'edit'
        AND "createdAt" < ${cutoff}
        AND id NOT IN (
          SELECT id FROM note_versions v2
          WHERE v2."noteId" = note_versions."noteId"
            AND v2."changeType" = 'edit'
          ORDER BY v2.version DESC
          LIMIT ?
        )
    `).run(keepRecent);
    return result.changes as number;
  },

  /**
   * 按 noteIds 批量查询版本记录。
   *
   * 用于用户迁移导出（export-light），按 noteId 集合一次性拉出所有版本。
   * 空集合返回空数组（调用方短路）。
   *
   * @param noteIds 笔记 ID 列表
   * @returns 版本记录列表
   */
  listByNoteIds(noteIds: string[]): NoteVersionRecord[] {
    if (noteIds.length === 0) return [];
    const db = getDb();
    const placeholders = noteIds.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, "noteId", "userId", title, content, "contentText", "contentFormat", version,
                "changeType", "changeSummary", "createdAt", kind, source, label, description
         FROM note_versions
         WHERE "noteId" IN (${placeholders})`,
      )
      .all(...noteIds) as unknown as NoteVersionRecord[];
  },

  /**
   * 统计用户的版本数量。
   *
   * @param userId 用户 ID
   * @returns 版本数量
   */
  countByUser(userId: string): number {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as c FROM note_versions WHERE "userId" = ?').get(userId) as { c: number };
    return row.c;
  },

  /**
   * 转移用户（用户迁移时使用）。
   *
   * @param fromUserId 源用户 ID
   * @param toUserId 目标用户 ID
   * @returns 更新的行数
   */
  transferOwnership(fromUserId: string, toUserId: string): number {
    const db = getDb();
    const result = db.prepare('UPDATE note_versions SET "userId" = ? WHERE "userId" = ?').run(toUserId, fromUserId);
    return result.changes as number;
  },

  async listByNoteIdAsync(noteId: string, limit: number, offset: number): Promise<NoteVersionListItem[]> {
    return getAdapter().queryMany<NoteVersionListItem>(
      `SELECT nv.id, nv."noteId", nv."userId", nv.title, nv.version, nv."changeType", nv."changeSummary", nv."createdAt",
              u.username
       FROM note_versions nv
       LEFT JOIN users u ON nv."userId" = u.id
       WHERE nv."noteId" = ?
       ORDER BY nv.version DESC
       LIMIT ? OFFSET ?`,
      [noteId, limit, offset],
    );
  },

  async countByNoteIdAsync(noteId: string): Promise<number> {
    const row = await getAdapter().queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM note_versions WHERE "noteId" = ?',
      [noteId],
    );
    return row?.count ?? 0;
  },

  async getByIdAndNoteIdAsync(id: string, noteId: string): Promise<NoteVersionRecord | undefined> {
    return getAdapter().queryOne<NoteVersionRecord>(
      'SELECT * FROM note_versions WHERE id = ? AND "noteId" = ?',
      [id, noteId],
    );
  },

  async getLastEditByNoteIdAsync(noteId: string): Promise<{ createdAt: string } | undefined> {
    return getAdapter().queryOne<{ createdAt: string }>(
      `SELECT "createdAt" FROM note_versions
       WHERE "noteId" = ? AND "changeType" = 'edit'
       ORDER BY version DESC
       LIMIT 1`,
      [noteId],
    );
  },

  async createAsync(input: {
    id: string;
    noteId: string;
    userId: string;
    title: string;
    content: string;
    contentText: string;
    contentFormat?: string;
    version: number;
    changeType: 'edit' | 'guest_edit' | 'restore';
    changeSummary?: string;
    createdAt?: string;
  }): Promise<void> {
    const hasChangeSummary = input.changeSummary !== undefined;
    const hasCreatedAt = input.createdAt !== undefined;
    const contentFormat = input.contentFormat || "tiptap-json";

    if (hasChangeSummary && hasCreatedAt) {
      await getAdapter().execute(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType", "changeSummary", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.title, input.content, input.contentText, contentFormat, input.version, input.changeType, input.changeSummary, input.createdAt],
      );
    } else if (hasChangeSummary) {
      await getAdapter().execute(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType", "changeSummary")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.title, input.content, input.contentText, contentFormat, input.version, input.changeType, input.changeSummary],
      );
    } else if (hasCreatedAt) {
      await getAdapter().execute(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.title, input.content, input.contentText, contentFormat, input.version, input.changeType, input.createdAt],
      );
    } else {
      await getAdapter().execute(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.noteId, input.userId, input.title, input.content, input.contentText, contentFormat, input.version, input.changeType],
      );
    }
  },

  async deleteByNoteIdAsync(noteId: string): Promise<number> {
    const result = await getAdapter().execute(
      'DELETE FROM note_versions WHERE "noteId" = ?',
      [noteId],
    );
    return result.changes;
  },

  async pruneOldVersionsAsync(keepRecent: number, keepDays: number): Promise<number> {
    const cutoff = `datetime('now', '-${keepDays} days')`;
    const result = await getAdapter().execute(
      `DELETE FROM note_versions
       WHERE "changeType" = 'edit'
         AND "createdAt" < ${cutoff}
         AND id NOT IN (
           SELECT id FROM note_versions v2
           WHERE v2."noteId" = note_versions."noteId"
             AND v2."changeType" = 'edit'
           ORDER BY v2.version DESC
           LIMIT ?
         )`,
      [keepRecent],
    );
    return result.changes;
  },

  async listByNoteIdsAsync(noteIds: string[]): Promise<NoteVersionRecord[]> {
    if (noteIds.length === 0) return [];
    const placeholders = noteIds.map(() => "?").join(",");
    return getAdapter().queryMany<NoteVersionRecord>(
      `SELECT id, "noteId", "userId", title, content, "contentText", "contentFormat", version,
              "changeType", "changeSummary", "createdAt"
       FROM note_versions
       WHERE "noteId" IN (${placeholders})`,
      noteIds,
    );
  },

  async countByUserAsync(userId: string): Promise<number> {
    const row = await getAdapter().queryOne<{ c: number }>(
      'SELECT COUNT(*) as c FROM note_versions WHERE "userId" = ?',
      [userId],
    );
    return row?.c ?? 0;
  },

  async transferOwnershipAsync(fromUserId: string, toUserId: string): Promise<number> {
    const result = await getAdapter().execute(
      'UPDATE note_versions SET "userId" = ? WHERE "userId" = ?',
      [toUserId, fromUserId],
    );
    return result.changes;
  },

  /**
   * v2 统一版本创建入口（自动快照/手动备份/还原备份共用）。
   *
   * - 计算 contentHash（内容指纹，供自动快照去重与快照端点幂等判断）；
   * - 解析 content 中的附件引用写入 version_attachment_refs（版本级引用源，
   *   供附件孤儿扫描排除「仅被历史版本引用」的附件）；
   * - 版本行与引用行在同一事务内写入。
   */
  createTypedVersion(input: {
    noteId: string;
    userId: string;
    kind: "auto" | "manual";
    /** 快照来源（v134）：不传时按 kind 推导（auto→auto，manual→manual） */
    source?: VersionSource;
    changeType: "edit" | "guest_edit" | "restore";
    label?: string;
    description?: string;
    changeSummary?: string;
    snapshot: {
      title: string;
      content: string;
      contentText: string;
      contentFormat: string;
      version: number;
    };
  }): { id: string; version: number } {
    const db = getDb();
    const id = uuid();
    const contentFormat = input.snapshot.contentFormat || "tiptap-json";
    const contentHash = computeContentHash({
      title: input.snapshot.title,
      content: input.snapshot.content,
      contentText: input.snapshot.contentText,
      contentFormat,
    });
    const source: VersionSource = input.source ?? (input.kind === "auto" ? "auto" : "manual");
    db.transaction(() => {
      db.prepare(
        `INSERT INTO note_versions (id, "noteId", "userId", title, content, "contentText", "contentFormat", version, "changeType", "changeSummary", kind, source, label, description, "contentHash")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.noteId,
        input.userId,
        input.snapshot.title,
        input.snapshot.content,
        input.snapshot.contentText,
        contentFormat,
        input.snapshot.version,
        input.changeType,
        input.changeSummary ?? null,
        source,
        source,
        input.label ?? null,
        input.description ?? null,
        contentHash,
      );
      const attachmentIds = extractAttachmentIdsFromContent(input.snapshot.content);
      if (attachmentIds.size > 0) {
        const insertRef = db.prepare(
          'INSERT OR IGNORE INTO version_attachment_refs ("versionId", "attachmentId") VALUES (?, ?)',
        );
        for (const attachmentId of attachmentIds) insertRef.run(id, attachmentId);
      }
    })();
    return { id, version: input.snapshot.version };
  },

  /** 旧版本 contentHash 为 NULL 时按行内容补算并写回；已有值直接返回。 */
  ensureContentHash(versionId: string): string | null {
    const db = getDb();
    const row = db
      .prepare('SELECT title, content, "contentText", "contentFormat", "contentHash" FROM note_versions WHERE id = ?')
      .get(versionId) as
      | { title: string | null; content: string | null; contentText: string | null; contentFormat: string; contentHash: string | null }
      | undefined;
    if (!row) return null;
    if (row.contentHash) return row.contentHash;
    const hash = computeContentHash({
      title: row.title,
      content: row.content,
      contentText: row.contentText,
      contentFormat: row.contentFormat,
    });
    db.prepare('UPDATE note_versions SET "contentHash" = ? WHERE id = ?').run(hash, versionId);
    return hash;
  },

  getLatestVersionByNoteId(noteId: string): { id: string; contentHash: string | null; createdAt: string } | undefined {
    const db = getDb();
    // createdAt 优先：保存路径移除后 version 可能并列（快照不递增 note.version）。
    // createdAt 只精确到秒，同秒内并列时用 rowid（插入顺序）决胜，id 是随机 uuid 不可用作次序。
    return db
      .prepare('SELECT id, "contentHash", "createdAt" FROM note_versions WHERE "noteId" = ? ORDER BY "createdAt" DESC, rowid DESC LIMIT 1')
      .get(noteId) as { id: string; contentHash: string | null; createdAt: string } | undefined;
  },

  /** 删除单个版本（含版本附件引用）；noteId 不匹配时无操作。 */
  deleteVersionById(noteId: string, versionId: string): { deleted: boolean; freedAttachmentIds: string[] } {
    const db = getDb();
    let deleted = false;
    let freedAttachmentIds: string[] = [];
    db.transaction(() => {
      const refs = db.prepare('SELECT "attachmentId" FROM version_attachment_refs WHERE "versionId" = ?').all(versionId) as Array<{ attachmentId: string }>;
      const result = db.prepare('DELETE FROM note_versions WHERE id = ? AND "noteId" = ?').run(versionId, noteId);
      deleted = result.changes > 0;
      if (deleted) {
        db.prepare('DELETE FROM version_attachment_refs WHERE "versionId" = ?').run(versionId);
        freedAttachmentIds = enqueueFreedVersionAttachments(db, refs.map((ref) => ref.attachmentId));
      }
    })();
    return { deleted, freedAttachmentIds };
  },

  /** 批量删除（仅 source=auto 生效，manual/release 跳过计数）。 */
  deleteAutoVersionsByIds(noteId: string, ids: string[]): { deleted: number; skipped: number; freedAttachmentIds: string[] } {
    const db = getDb();
    if (ids.length === 0) return { deleted: 0, skipped: 0, freedAttachmentIds: [] };
    let deleted = 0;
    let skipped = 0;
    const freed = new Set<string>();
    db.transaction(() => {
      const select = db.prepare('SELECT source FROM note_versions WHERE id = ? AND "noteId" = ?');
      const selectRefs = db.prepare('SELECT "attachmentId" FROM version_attachment_refs WHERE "versionId" = ?');
      const deleteRefs = db.prepare('DELETE FROM version_attachment_refs WHERE "versionId" = ?');
      const deleteRow = db.prepare("DELETE FROM note_versions WHERE id = ?");
      for (const id of ids) {
        const row = select.get(id, noteId) as { source: string } | undefined;
        if (!row || row.source !== "auto") {
          skipped += 1;
          continue;
        }
        const refs = selectRefs.all(id) as Array<{ attachmentId: string }>;
        for (const ref of refs) freed.add(ref.attachmentId);
        deleteRefs.run(id);
        deleteRow.run(id);
        deleted += 1;
      }
    })();
    const freedAttachmentIds = enqueueFreedVersionAttachments(db, [...freed]);
    return { deleted, skipped, freedAttachmentIds };
  },

  /** 清空某笔记版本历史（语义：仅清 auto，manual/release 保留并计数）。 */
  clearAutoByNoteId(noteId: string): { deleted: number; skippedManual: number; freedAttachmentIds: string[] } {
    const db = getDb();
    let deleted = 0;
    let skippedManual = 0;
    const freed = new Set<string>();
    db.transaction(() => {
      const rows = db.prepare('SELECT id, source FROM note_versions WHERE "noteId" = ?').all(noteId) as Array<{ id: string; source: string }>;
      const selectRefs = db.prepare('SELECT "attachmentId" FROM version_attachment_refs WHERE "versionId" = ?');
      const deleteRefs = db.prepare('DELETE FROM version_attachment_refs WHERE "versionId" = ?');
      const deleteRow = db.prepare("DELETE FROM note_versions WHERE id = ?");
      for (const row of rows) {
        if (row.source !== "auto") {
          skippedManual += 1;
          continue;
        }
        const refs = selectRefs.all(row.id) as Array<{ attachmentId: string }>;
        for (const ref of refs) freed.add(ref.attachmentId);
        deleteRefs.run(row.id);
        deleteRow.run(row.id);
        deleted += 1;
      }
    })();
    const freedAttachmentIds = enqueueFreedVersionAttachments(db, [...freed]);
    return { deleted, skippedManual, freedAttachmentIds };
  },

  sumContentBytesByNoteId(noteId: string): number {
    const db = getDb();
    const row = db
      .prepare('SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS total FROM note_versions WHERE "noteId" = ?')
      .get(noteId) as { total: number };
    return row.total;
  },

  /** 保留策略：每笔记保留最近 N 条指定来源（auto/manual）版本，其余删除；release 不参与。 */
  pruneVersionsBySourceCount(source: "auto" | "manual", keepRecent: number): { deleted: number; freedBytes: number; freedAttachmentIds: string[] } {
    const db = getDb();
    const doomed = db
      .prepare(
        `SELECT nv.id, COALESCE(LENGTH(CAST(nv.content AS BLOB)), 0) AS bytes
         FROM note_versions nv
         WHERE nv.source = ?
           AND nv.id NOT IN (
             SELECT v2.id FROM note_versions v2
             WHERE v2."noteId" = nv."noteId" AND v2.source = ?
             ORDER BY v2.version DESC, v2."createdAt" DESC
             LIMIT ?
           )`,
      )
      .all(source, source, Math.max(0, keepRecent)) as Array<{ id: string; bytes: number }>;
    const result = deleteVersionRowsWithRefs(db, doomed.map((row) => row.id));
    return { deleted: result.deleted, freedBytes: doomed.reduce((sum, row) => sum + row.bytes, 0), freedAttachmentIds: result.freedAttachmentIds };
  },

  /** 保留策略：删除 N 天前的指定来源（auto/manual）版本；release 不参与。 */
  pruneVersionsBySourceDays(source: "auto" | "manual", days: number): { deleted: number; freedBytes: number; freedAttachmentIds: string[] } {
    const db = getDb();
    const doomed = db
      .prepare(
        `SELECT nv.id, COALESCE(LENGTH(CAST(nv.content AS BLOB)), 0) AS bytes
         FROM note_versions nv
         WHERE nv.source = ? AND nv."createdAt" < datetime('now', ?)`,
      )
      .all(source, `-${Math.max(1, Math.round(days))} days`) as Array<{ id: string; bytes: number }>;
    const result = deleteVersionRowsWithRefs(db, doomed.map((row) => row.id));
    return { deleted: result.deleted, freedBytes: doomed.reduce((sum, row) => sum + row.bytes, 0), freedAttachmentIds: result.freedAttachmentIds };
  },

  /** 保留策略：每笔记保留最近 N 条 auto，其余删除。 */
  pruneAutoVersionsByCount(keepRecent: number): { deleted: number; freedBytes: number; freedAttachmentIds: string[] } {
    return noteVersionsRepository.pruneVersionsBySourceCount("auto", keepRecent);
  },

  /** 保留策略：删除 N 天前的 auto 版本。 */
  pruneAutoVersionsByDays(days: number): { deleted: number; freedBytes: number; freedAttachmentIds: string[] } {
    return noteVersionsRepository.pruneVersionsBySourceDays("auto", days);
  },

  /**
   * 相邻同内容记录合并：同一笔记内，source 相同（auto/manual）且 contentHash 相同的
   * 相邻记录只保留最新一条，其余删除；release 记录永不合并删除。
   * 不传 noteId 时全库执行（保留策略兜底）；用于防御「同内容重复提交」造成的堆积。
   */
  mergeAdjacentSameContent(noteId?: string): { merged: number; freedAttachmentIds: string[] } {
    const db = getDb();
    const scopeClause = noteId ? 'AND "noteId" = ?' : "";
    const params = noteId ? [noteId] : [];
    // 每条「存在同 source 同 hash 且更新一条兄弟记录」的行都该删（连续重复段只留最新）
    const doomed = db
      .prepare(
        `SELECT v1.id FROM note_versions v1
         WHERE v1.source IN ('auto', 'manual') AND v1."contentHash" IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM note_versions v2
             WHERE v2."noteId" = v1."noteId"
               AND v2.source = v1.source
               AND v2."contentHash" = v1."contentHash"
               AND (v2."createdAt" > v1."createdAt" OR (v2."createdAt" = v1."createdAt" AND v2.rowid > v1.rowid))
           )${scopeClause}`,
      )
      .all(...params) as Array<{ id: string }>;
    const result = deleteVersionRowsWithRefs(db, doomed.map((row) => row.id));
    return { merged: result.deleted, freedAttachmentIds: result.freedAttachmentIds };
  },

  /** 更新版本来源（release 标记/取消共用）；noteId 不匹配时无操作。kind 与 source 同步写。 */
  setVersionSource(noteId: string, versionId: string, source: VersionSource): boolean {
    const db = getDb();
    const result = db
      .prepare('UPDATE note_versions SET source = ?, kind = ? WHERE id = ? AND "noteId" = ?')
      .run(source, source, versionId, noteId);
    return result.changes > 0;
  },

  /** P2 存储配额：auto 总字节超过 quotaBytes 时按最旧优先删除，直到回到配额内。 */
  pruneAutoVersionsOverQuota(quotaBytes: number): { deleted: number; freedBytes: number; freedAttachmentIds: string[] } {
    if (quotaBytes <= 0) return { deleted: 0, freedBytes: 0, freedAttachmentIds: [] };
    const db = getDb();
    let deleted = 0;
    let freedBytes = 0;
    const freedAttachmentIds: string[] = [];
    // 分批删最旧的 auto，直到总量回到配额内（防单事务过长；上限 1000 批防死循环）
    for (let round = 0; round < 1000; round += 1) {
      const total = db
        .prepare(`SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS total FROM note_versions WHERE source = 'auto'`)
        .get() as { total: number };
      if (total.total <= quotaBytes) break;
      const doomed = db
        .prepare(
          `SELECT nv.id, COALESCE(LENGTH(CAST(nv.content AS BLOB)), 0) AS bytes
           FROM note_versions nv
           WHERE nv.source = 'auto'
           ORDER BY nv."createdAt" ASC, nv.id ASC
           LIMIT 1`,
        )
        .all() as Array<{ id: string; bytes: number }>;
      if (doomed.length === 0) break;
      const result = deleteVersionRowsWithRefs(db, doomed.map((row) => row.id));
      if (result.deleted === 0) break;
      deleted += result.deleted;
      freedBytes += doomed.reduce((sum, row) => sum + row.bytes, 0);
      freedAttachmentIds.push(...result.freedAttachmentIds);
    }
    return { deleted, freedBytes, freedAttachmentIds };
  },

  /** 清扫悬空版本附件引用（版本行已不存在时的残留）。 */
  deleteDanglingAttachmentRefs(): number {
    const db = getDb();
    const result = db
      .prepare('DELETE FROM version_attachment_refs WHERE "versionId" NOT IN (SELECT id FROM note_versions)')
      .run();
    return result.changes as number;
  },
};

type VersionDb = ReturnType<typeof getDb>;

/** 删除版本行并同步清理版本附件引用（事务内逐行删除）；失去全部引用的附件进入 GC 宽限队列。 */
function deleteVersionRowsWithRefs(db: VersionDb, ids: string[]): { deleted: number; freedAttachmentIds: string[] } {
  if (ids.length === 0) return { deleted: 0, freedAttachmentIds: [] };
  let deleted = 0;
  const freed = new Set<string>();
  db.transaction(() => {
    const selectRefs = db.prepare('SELECT "attachmentId" FROM version_attachment_refs WHERE "versionId" = ?');
    const deleteRefs = db.prepare('DELETE FROM version_attachment_refs WHERE "versionId" = ?');
    const deleteRow = db.prepare("DELETE FROM note_versions WHERE id = ?");
    for (const id of ids) {
      const refs = selectRefs.all(id) as Array<{ attachmentId: string }>;
      for (const ref of refs) freed.add(ref.attachmentId);
      deleteRefs.run(id);
      deleteRow.run(id);
      deleted += 1;
    }
  })();
  const freedAttachmentIds = enqueueFreedVersionAttachments(db, [...freed]);
  return { deleted, freedAttachmentIds };
}

/**
 * 版本附件两阶段 GC 第一阶段：失去全部引用（当前内容 + 所有版本均不再引用）的附件
 * 进入 version_gc_queue 宽限队列（默认 7 天），由调度器物理删除并输出审计日志。
 */
function enqueueFreedVersionAttachments(db: VersionDb, attachmentIds: string[]): string[] {
  if (attachmentIds.length === 0) return [];
  const enqueued: string[] = [];
  const getAttachment = db.prepare("SELECT path, size FROM attachments WHERE id = ?");
  const hasNoteRef = db.prepare('SELECT 1 FROM attachment_references WHERE "attachmentId" = ? LIMIT 1');
  const hasVersionRef = db.prepare('SELECT 1 FROM version_attachment_refs WHERE "attachmentId" = ? LIMIT 1');
  const alreadyQueued = db.prepare('SELECT 1 FROM version_gc_queue WHERE "attachmentId" = ? LIMIT 1');
  const insert = db.prepare('INSERT OR IGNORE INTO version_gc_queue ("attachmentId", path, bytes) VALUES (?, ?, ?)');
  for (const id of attachmentIds) {
    const attachment = getAttachment.get(id) as { path: string; size: number } | undefined;
    if (!attachment) continue;
    if (hasNoteRef.get(id)) continue;
    if (hasVersionRef.get(id)) continue;
    if (alreadyQueued.get(id)) continue;
    insert.run(id, attachment.path, attachment.size ?? 0);
    enqueued.push(id);
  }
  return enqueued;
}

/**
 * 内容指纹（版本历史 v2）：sha1(title / contentFormat / contentText / content) 前 16 位 hex。
 * - 加密笔记的 content 为密文，同样参与 hash（contentText 为空也能检测变化）；
 * - 自动快照去重、快照端点幂等判断共用同一实现。
 */
export function computeContentHash(input: {
  title?: string | null;
  content?: string | null;
  contentText?: string | null;
  contentFormat?: string | null;
}): string {
  const digest = createHash("sha1")
    .update(`${input.title ?? ""}\n${input.contentFormat ?? ""}\n${input.contentText ?? ""}\n${input.content ?? ""}`)
    .digest("hex");
  return digest.slice(0, 16);
}
