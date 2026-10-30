import type { Migration } from "./migrations.impl.js";

// 工作区头像：改用上传图片，avatarUrl 存带版本号的相对 URL。
export const workspaceAvatarMigration: Migration = {
  version: 136,
  name: "workspace-avatars",
  up: (db) => {
    const cols = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "avatarUrl")) {
      db.prepare("ALTER TABLE workspaces ADD COLUMN avatarUrl TEXT").run();
    }
  },
};
