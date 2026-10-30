-- 工作区头像：上传图片替代 emoji 图标展示。
-- 对应 SQLite 迁移 v131（workspaceAvatarMigration.ts）。
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
