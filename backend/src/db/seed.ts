import { getDb } from "./schema";
import { v4 as uuid } from "uuid";
import crypto from "crypto";

function syncIcpBeianFromEnv() {
  const db = getDb();
  const raw = process.env.BASEFORGE_ICP_BEIAN ?? process.env.ICP_BEIAN ?? "";
  const value = String(raw).trim().slice(0, 80);
  db.prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES ('site_icp_beian', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `).run(value);
}

export function seedDatabase() {
  const db = getDb();

  // ICP 备案号由 Docker/运行时环境变量驱动，不再通过设置页写入。
  // 每次启动都同步一次，避免旧数据库里残留的 site_icp_beian 继续影响登录页展示。
  syncIcpBeianFromEnv();

  const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  if (userCount.count > 0) return;

  const userId = uuid();
  const passwordHash = crypto.createHash("sha256").update("admin123").digest("hex");

  db.prepare(`
    INSERT INTO users (id, username, email, passwordHash, role, displayName) VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, "admin", "admin@baseforge.local", passwordHash, "admin", "管理员");

  // 新数据库只创建可登录的默认账号，不再写入任何示例知识库/笔记/标签：
  // 空白起步由用户自己建库，避免一上来就是一堆 demo 内容。
  console.log("✅ Database initialized with the default admin account");
}
