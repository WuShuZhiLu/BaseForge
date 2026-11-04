/**
 * 附件分享链接（/api/attachment-shares）
 * ---------------------------------------------------------------------------
 * FileManager 附件的只读可控分享：可设密码 / 过期时间 / 查看次数上限；
 * 可关闭（isActive=0，设置保留、链接立即失效）或彻底删除。
 *
 * 两个子路由（同 index.ts 的 /api/attachments 先例，公开段在前、JWT 段在后）：
 *   - attachmentSharePublicRouter：挂在 JWT 中间件之前，匿名凭 token 访问
 *     GET  /:token/meta      分享元信息（是否需要密码等）
 *     POST /:token/verify    密码校验，换短期访问 token
 *     GET  /:token/content   下载内容（关闭/过期/超次一律 404，不泄露存在性）
 *   - attachmentSharesRouter：挂在 JWT 中间件之后（X-User-Id）
 *     POST /                 开启/更新分享（一个附件一条，重复 POST 复用并重开）
 *     GET  /                 我的分享列表
 *     PATCH /:id             改密码/过期/次数/开关
 *     DELETE /:id            彻底删除
 *
 * 与现有通道的关系：
 *   - /api/attachments/:id 免 JWT 直链（uuid 不可枚举）保持不动，避免破坏 <img> 内联；
 *   - routes/attachments.ts 的运行时 file_shares（无密码/次数）亦不改动；
 *     本表是叠加的可控通道，字段对齐笔记 shares 的密码/过期/次数语义。
 */
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { resolveNotePermission, hasPermission } from "../middleware/acl";
import { signShareAccessToken, verifyShareAccessToken } from "../lib/auth-security";
import {
  checkCredentialAttempt,
  getClientIp,
  hashClientIp,
  recordCredentialFailure,
  recordCredentialSuccess,
} from "../lib/share-credential-rate-limit";
import { logAudit } from "../services/audit";
import { defaultShareExpiresAt } from "../lib/share-defaults";
import { readAttachmentObject } from "../services/attachment-storage";
import { isHighRiskMime, encodeContentDispositionFilename } from "./attachments-core";

// 与 shares.ts 同款：crypto.randomBytes 生成高熵 URL-safe token，不可枚举。
function generateShareToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function isExpired(expiresAt: string | null | undefined): boolean {
  return !!expiresAt && new Date(expiresAt) < new Date();
}

function isViewExhausted(share: { maxViews: number | null; viewCount: number }): boolean {
  return share.maxViews !== null && share.maxViews !== undefined && share.viewCount >= share.maxViews;
}

/** 关闭/过期/超次统一 404：不向匿名访问者泄露分享的存在与状态。 */
function findAccessibleShareByToken(db: ReturnType<typeof getDb>, token: string) {
  return db.prepare(`
    SELECT s.*, a.noteId, a.filename, a.mimeType, a.size, a.path
    FROM attachment_shares s
    JOIN attachments a ON s.attachmentId = a.id
    WHERE s.shareToken = ?
  `).get(token) as
    | (Record<string, any> & {
        noteId: string; filename: string; mimeType: string; size: number; path: string;
        password: string | null; expiresAt: string | null;
        maxViews: number | null; viewCount: number; isActive: number;
        credentialVersion: number;
      })
    | undefined;
}

function validateShareSettings(body: {
  password?: unknown; expiresAt?: unknown; maxViews?: unknown;
}): { password: string | null; expiresAt: string | null | undefined; maxViews: number | null } | { error: string; status: number } {
  let password: string | null = null;
  if (body.password !== undefined && body.password !== null && String(body.password).trim() !== "") {
    password = String(body.password).trim();
    if (password.length < 4 || password.length > 128) {
      return { error: "密码长度需为 4-128 个字符", status: 400 };
    }
  }
  // undefined = 未指定（新建时由调用方补默认 7 天）；null = 显式要求永久。
  let expiresAt: string | null | undefined;
  if (body.expiresAt === null) {
    expiresAt = null;
  } else if (body.expiresAt !== undefined && String(body.expiresAt).trim() !== "") {
    expiresAt = String(body.expiresAt);
    if (isNaN(new Date(expiresAt).getTime())) {
      return { error: "过期时间无效", status: 400 };
    }
  }
  let maxViews: number | null = null;
  if (body.maxViews !== undefined && body.maxViews !== null && body.maxViews !== "") {
    maxViews = Number(body.maxViews);
    if (!Number.isInteger(maxViews) || maxViews < 1 || maxViews > 1_000_000) {
      return { error: "查看次数上限无效", status: 400 };
    }
  }
  return { password, expiresAt, maxViews };
}

function publicShareView(share: Record<string, any>) {
  const hasPassword = !!share.password;
  const { password: _password, ...rest } = share;
  return { ...rest, isActive: !!rest.isActive, hasPassword };
}

// ===== 匿名公开路由（index.ts 挂在 JWT 中间件之前） =====
export const attachmentSharePublicRouter = new Hono();

attachmentSharePublicRouter.get("/:token/meta", (c) => {
  const db = getDb();
  const share = findAccessibleShareByToken(db, c.req.param("token"));
  if (!share || !share.isActive || isExpired(share.expiresAt) || isViewExhausted(share)) {
    return c.json({ error: "分享链接不存在或已失效" }, 404);
  }
  return c.json({
    id: share.id,
    filename: share.filename,
    mimeType: share.mimeType,
    size: share.size,
    needPassword: !!share.password,
    expiresAt: share.expiresAt,
    createdAt: share.createdAt,
  });
});

attachmentSharePublicRouter.post("/:token/verify", async (c) => {
  const db = getDb();
  const token = c.req.param("token");
  const share = findAccessibleShareByToken(db, token);
  if (!share || !share.isActive || isExpired(share.expiresAt) || isViewExhausted(share)) {
    return c.json({ error: "分享链接不存在或已失效" }, 404);
  }

  if (share.password) {
    const body = await c.req.json().catch(() => ({}));
    const password = String(body.password || "");
    if (!password) return c.json({ error: "请输入访问密码" }, 400);

    // 与 shares.ts 同款：IP × token 维度的密码爆破限频
    const ipHash = hashClientIp(getClientIp(c));
    const rateKey = `attachment-share:${share.id}:${ipHash}`;
    const rate = checkCredentialAttempt(rateKey);
    if (!rate.allowed) {
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return c.json({ error: "验证尝试过于频繁，请稍后再试", code: "SHARE_CREDENTIAL_RATE_LIMIT" }, 429);
    }
    if (!(await bcrypt.compare(password, share.password))) {
      recordCredentialFailure(rateKey);
      logAudit("", "share", "attachment_share_credential_failure", { shareId: share.id, ipHash }, {
        targetType: "attachment-share", targetId: share.id, ip: ipHash, level: "warn",
      });
      return c.json({ error: "访问密码错误" }, 403);
    }
    recordCredentialSuccess(rateKey);
  }

  // 无密码分享也签发：content 端点统一凭 token 读取，逻辑单一
  const accessToken = signShareAccessToken({
    shareId: share.id,
    noteId: share.noteId,
    credentialVersion: share.credentialVersion,
  });
  return c.json({ success: true, accessToken });
});

attachmentSharePublicRouter.get("/:token/content", async (c) => {
  const db = getDb();
  const token = c.req.param("token");
  const share = findAccessibleShareByToken(db, token);
  if (!share || !share.isActive || isExpired(share.expiresAt) || isViewExhausted(share)) {
    return c.json({ error: "分享链接不存在或已失效" }, 404);
  }

  // 密码分享必须先 verify 换取短期访问 token（改密后 credentialVersion 变化，旧 token 失效）
  if (share.password) {
    const authHeader = c.req.header("Authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const payload = bearer ? verifyShareAccessToken(bearer, share.id, share.credentialVersion) : null;
    if (!payload) {
      return c.json({ error: "需要密码验证", needPassword: true }, 401);
    }
  }

  const buffer = await readAttachmentObject(share.path);
  if (!buffer) return c.json({ error: "附件文件缺失" }, 404);

  db.prepare(
    "UPDATE attachment_shares SET viewCount = viewCount + 1, updatedAt = datetime('now') WHERE id = ?",
  ).run(share.id);

  // MIME 头照抄 attachments-core.ts 下载路径的原图分支
  const forceDownload = c.req.query("download") === "1";
  const headers: Record<string, string> = {
    "Content-Type": share.mimeType || "application/octet-stream",
    // 分享可随时关闭/撤销，禁止中间副本长期缓存
    "Cache-Control": "private, no-store",
  };
  const isHighRisk = isHighRiskMime(share.mimeType);
  if (isHighRisk || !share.mimeType.startsWith("image/") || forceDownload) {
    headers["Content-Disposition"] = encodeContentDispositionFilename(share.filename || "");
    if (isHighRisk) headers["X-Content-Type-Options"] = "nosniff";
  }
  return c.body(new Uint8Array(buffer), 200, headers);
});

// ===== 管理路由（index.ts 挂在 JWT 中间件之后，X-User-Id） =====
export const attachmentSharesRouter = new Hono();

attachmentSharesRouter.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({})) as {
    attachmentId?: string; password?: string; expiresAt?: string; maxViews?: number;
  };
  const attachmentId = String(body.attachmentId || "").trim();
  if (!attachmentId) return c.json({ error: "缺少 attachmentId 参数" }, 400);

  const attachment = db
    .prepare("SELECT id, noteId, userId FROM attachments WHERE id = ?")
    .get(attachmentId) as { id: string; noteId: string; userId: string } | undefined;
  if (!attachment) return c.json({ error: "附件不存在" }, 404);

  // 附件属当前用户，或对其来源笔记有 write 权限
  let allowed = attachment.userId === userId;
  if (!allowed && attachment.noteId) {
    const { permission } = resolveNotePermission(attachment.noteId, userId);
    allowed = hasPermission(permission, "write");
  }
  if (!allowed) return c.json({ error: "无权分享该附件" }, 403);

  const settings = validateShareSettings(body);
  if ("error" in settings) return c.json({ error: settings.error }, settings.status as 400);
  // 没指定有效期就是 7 天：批量「生成公开链接」传的是空对象，以前会落成一堆永久裸链。
  const expiresAt = settings.expiresAt === undefined ? defaultShareExpiresAt() : settings.expiresAt;

  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT * FROM attachment_shares WHERE attachmentId = ?")
    .get(attachmentId) as Record<string, any> | undefined;

  if (existing) {
    // 复用同一行：重复开启 = 重开 + 覆盖设置；改密则 bump credentialVersion 让旧访问 token 失效
    const passwordChanged = (settings.password || null) !== (existing.password || null);
    const credentialVersion = passwordChanged ? existing.credentialVersion + 1 : existing.credentialVersion;
    db.prepare(`
      UPDATE attachment_shares
      SET password = ?, expiresAt = ?, maxViews = ?, isActive = 1,
          credentialVersion = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(
      settings.password ? await bcrypt.hash(settings.password, 10) : null,
      expiresAt, settings.maxViews, credentialVersion, existing.id,
    );
    const share = db.prepare("SELECT * FROM attachment_shares WHERE id = ?").get(existing.id);
    return c.json(publicShareView(share as Record<string, any>), 200);
  }

  const id = uuid();
  const shareToken = generateShareToken();
  db.prepare(`
    INSERT INTO attachment_shares (id, attachmentId, ownerId, shareToken, password, expiresAt, maxViews)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, attachmentId, userId, shareToken,
    settings.password ? await bcrypt.hash(settings.password, 10) : null,
    expiresAt, settings.maxViews,
  );
  logAudit(userId, "share", "attachment_share_create", {
    shareId: id, attachmentId, hasPassword: !!settings.password,
  }, { targetType: "attachment-share", targetId: id });

  const share = db.prepare("SELECT * FROM attachment_shares WHERE id = ?").get(id);
  return c.json(publicShareView(share as Record<string, any>), 201);
});

attachmentSharesRouter.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const shares = db.prepare(`
    SELECT s.*, a.filename, a.mimeType, a.size
    FROM attachment_shares s
    JOIN attachments a ON s.attachmentId = a.id
    WHERE s.ownerId = ?
    ORDER BY s.createdAt DESC
  `).all(userId) as any[];
  return c.json(shares.map((s) => publicShareView(s)));
});

attachmentSharesRouter.patch("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const share = db.prepare("SELECT * FROM attachment_shares WHERE id = ?")
    .get(c.req.param("id")) as Record<string, any> | undefined;
  if (!share) return c.json({ error: "分享不存在" }, 404);
  if (share.ownerId !== userId) {
    const attachment = db.prepare("SELECT noteId FROM attachments WHERE id = ?").get(share.attachmentId) as any;
    const { permission } = attachment?.noteId ? resolveNotePermission(attachment.noteId, userId) : { permission: null };
    if (!hasPermission(permission, "write")) return c.json({ error: "无权管理此分享" }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as {
    password?: string | null; expiresAt?: string | null; maxViews?: number | null;
    isActive?: boolean; resetViews?: boolean;
  };

  const fields: string[] = [];
  const params: any[] = [];
  let credentialChanged = false;

  if (body.password !== undefined) {
    if (body.password === null || String(body.password).trim() === "") {
      fields.push("password = ?"); params.push(null);
    } else {
      const next = String(body.password).trim();
      if (next.length < 4 || next.length > 128) {
        return c.json({ error: "密码长度需为 4-128 个字符" }, 400);
      }
      fields.push("password = ?"); params.push(await bcrypt.hash(next, 10));
    }
    credentialChanged = true;
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt !== null && String(body.expiresAt).trim() !== "" && isNaN(new Date(body.expiresAt).getTime())) {
      return c.json({ error: "过期时间无效" }, 400);
    }
    fields.push("expiresAt = ?");
    params.push(body.expiresAt === null || String(body.expiresAt).trim() === "" ? null : body.expiresAt);
  }
  if (body.maxViews !== undefined) {
    const value = body.maxViews === null || (body.maxViews as unknown) === "" ? null : Number(body.maxViews);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 1_000_000)) {
      return c.json({ error: "查看次数上限无效" }, 400);
    }
    fields.push("maxViews = ?"); params.push(value);
  }
  // 关闭分享：isActive=0，设置保留，链接立即失效；重开传 isActive=true
  if (body.isActive !== undefined) { fields.push("isActive = ?"); params.push(body.isActive ? 1 : 0); }
  if (credentialChanged) fields.push("credentialVersion = credentialVersion + 1");

  if (fields.length === 0 && body.resetViews !== true) {
    return c.json({ error: "没有需要更新的字段" }, 400);
  }
  if (fields.length > 0) {
    fields.push("updatedAt = datetime('now')");
    params.push(share.id);
    db.prepare(`UPDATE attachment_shares SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  }
  if (body.resetViews === true) {
    db.prepare("UPDATE attachment_shares SET viewCount = 0 WHERE id = ?").run(share.id);
  }

  const updated = db.prepare("SELECT * FROM attachment_shares WHERE id = ?").get(share.id);
  return c.json(publicShareView(updated as Record<string, any>));
});

attachmentSharesRouter.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const share = db.prepare("SELECT * FROM attachment_shares WHERE id = ?")
    .get(c.req.param("id")) as Record<string, any> | undefined;
  if (!share) return c.json({ error: "分享不存在" }, 404);
  if (share.ownerId !== userId) {
    const attachment = db.prepare("SELECT noteId FROM attachments WHERE id = ?").get(share.attachmentId) as any;
    const { permission } = attachment?.noteId ? resolveNotePermission(attachment.noteId, userId) : { permission: null };
    if (!hasPermission(permission, "write")) return c.json({ error: "无权删除此分享" }, 403);
  }
  db.prepare("DELETE FROM attachment_shares WHERE id = ?").run(share.id);
  logAudit(userId, "share", "attachment_share_delete", { shareId: share.id }, {
    targetType: "attachment-share", targetId: share.id,
  });
  return c.json({ success: true });
});
