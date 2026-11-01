/**
 * 分享中心路由（/api/share-center）
 * ---------------------------------------------------------------------------
 * GET  /        五路分享数据收口的统一列表 + 与列表同源的分组计数
 *   query: q, group(active|attention|disabled), objectKind(note|file|notebook),
 *          permission, hasPassword, risk(open_ended|orphan|unused|bare),
 *          expiresWithinDays, sort(lastSeenAt|updatedAt|createdAt|expiresAt|viewCount|title),
 *          order, page, pageSize
 * GET  /item?channel=&objectId=  按被分享对象定位单条（列表里的「分享」入口跳抽屉用）
 * GET  /:channel/:id/visits  单条分享的访问会话明细（抽屉「访问记录」）
 * POST /batch   批量停用 / 删除 / 设过期，单次 ≤200 项
 *   body: { action: "disable"|"delete"|"expire", items: [{channel,id}], expiresAt?: ISO }
 *
 * 只做读聚合与批量处置，单条分享的创建/改设置仍走各自原有端点
 * （/api/shares、/api/attachment-shares、目录对话框），避免把五套权限判定搬过来
 * 造成第二个口径来源。
 */
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { logAudit } from "../services/audit";
import {
  applyShareCenterBatchAction,
  parseShareCenterQuery,
  queryShareCenter,
  queryShareCenterItem,
  queryShareVisits,
  type ShareCenterBatchAction,
  type ShareCenterBatchTarget,
  type ShareCenterChannel,
} from "../services/share-center";

const BATCH_ACTIONS = new Set<ShareCenterBatchAction>(["disable", "delete", "expire"]);
const BATCH_LIMIT = 200;

export const shareCenterRouter = new Hono();

shareCenterRouter.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  return c.json(queryShareCenter(db, userId, parseShareCenterQuery(c.req.query())));
});

shareCenterRouter.get("/item", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const channel = c.req.query("channel") as ShareCenterChannel | undefined;
  const objectId = c.req.query("objectId") || "";
  if (!channel || !objectId) return c.json({ error: "channel 与 objectId 必填" }, 400);
  return c.json({ item: queryShareCenterItem(db, userId, channel, objectId) });
});

shareCenterRouter.get("/:channel/:id/visits", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const channel = c.req.param("channel") as ShareCenterChannel;
  const id = c.req.param("id");
  const limit = Number(c.req.query("limit") || 5);
  return c.json(queryShareVisits(db, userId, channel, id, Number.isFinite(limit) ? limit : 5));
});

shareCenterRouter.post("/batch", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({})) as {
    action?: string; items?: unknown; expiresAt?: string | null;
  };

  const action = body.action as ShareCenterBatchAction;
  if (!BATCH_ACTIONS.has(action)) return c.json({ error: "action 必须是 disable / delete / expire" }, 400);

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) return c.json({ error: "缺少 items" }, 400);
  if (rawItems.length > BATCH_LIMIT) {
    return c.json({ error: `单次最多处理 ${BATCH_LIMIT} 条分享` }, 400);
  }
  const targets = rawItems.filter((item: any): item is ShareCenterBatchTarget =>
    !!item && typeof item === "object" && typeof item.channel === "string" && typeof item.id === "string",
  );
  if (targets.length === 0) return c.json({ error: "items 格式无效" }, 400);

  let expiresAt: string | null = null;
  if (action === "expire") {
    expiresAt = body.expiresAt ? String(body.expiresAt) : null;
    if (!expiresAt) return c.json({ error: "expire 需要 expiresAt" }, 400);
    if (!Number.isFinite(Date.parse(expiresAt))) return c.json({ error: "过期时间无效" }, 400);
  }

  const result = applyShareCenterBatchAction(db, userId, action, targets, expiresAt);
  logAudit(userId, "share", `center_batch_${action}`, {
    requested: targets.length, succeeded: result.succeeded, failed: result.failed,
  }, { targetType: "share-center" });

  return c.json({ ...result, requested: targets.length });
});
