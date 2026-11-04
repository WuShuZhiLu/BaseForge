-- 附件分享链接：FileManager 附件的只读可控分享（密码/过期/次数上限）。
-- 对应 SQLite 迁移 v130（attachmentShareMigration.ts）。
CREATE TABLE IF NOT EXISTS attachment_shares (
    id TEXT PRIMARY KEY,
    "attachmentId" TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    "ownerId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "shareToken" TEXT NOT NULL UNIQUE,
    password TEXT,
    "expiresAt" TIMESTAMPTZ,
    "maxViews" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachment_shares_attachment ON attachment_shares("attachmentId");
CREATE INDEX IF NOT EXISTS idx_attachment_shares_owner ON attachment_shares("ownerId");
