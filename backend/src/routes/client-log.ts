/**
 * 客户端错误上报通道（dev 诊断专用，免鉴权读写，内存环形 50 条）。
 * 挂载于全局 /api/* 鉴权之前，使前端 window.error/unhandledrejection
 * 的自动上报在未登录/登录态失效时仍可落日志，供远程排障拉取。
 */
import { Hono } from "hono";

const clientLogRouter = new Hono();

const clientLogs: Array<{ at: string; source: string; message: string; stack: string }> = [];

clientLogRouter.post("/client-log", async (c) => {
  const body = await c.req.json().catch(() => ({}) as any);
  clientLogs.push({
    at: new Date().toISOString(),
    source: String(body.source ?? "unknown").slice(0, 40),
    message: String(body.message ?? "").slice(0, 500),
    stack: String(body.stack ?? "").slice(0, 3000),
  });
  if (clientLogs.length > 50) clientLogs.splice(0, clientLogs.length - 50);
  console.error("[client-log]", body.source, body.message);
  return c.json({ ok: true });
});

clientLogRouter.get("/client-log", (c) => c.json({ logs: clientLogs }));

export default clientLogRouter;
