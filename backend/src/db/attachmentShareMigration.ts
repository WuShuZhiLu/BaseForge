import type { Migration } from "./migrations.impl.js";

// 附件分享链接：FileManager 附件的只读可控分享（密码/过期/次数上限，可关闭可删除）。
// 与笔记 shares 表平行的独立通道；现有 /api/attachments/:id 免 JWT 直链保持不动。
export const attachmentShareMigration: Migration = {
  version: 130,
  name: "attachment-shares",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_shares (
        id TEXT PRIMARY KEY,
        attachmentId TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        shareToken TEXT NOT NULL UNIQUE,
        password TEXT,
        expiresAt TEXT,
        maxViews INTEGER,
        viewCount INTEGER NOT NULL DEFAULT 0,
        isActive INTEGER NOT NULL DEFAULT 1,
        credentialVersion INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE,
        FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachment_shares_attachment
        ON attachment_shares(attachmentId);
      CREATE INDEX IF NOT EXISTS idx_attachment_shares_owner
        ON attachment_shares(ownerId);
    `);
  },
};
