/**
 * 视频首帧海报（统一文件池 · 第二阶段）
 * ---------------------------------------------------------------------------
 * 覆盖三件事：
 *   1. 带 ?w= 的视频请求返回 ffmpeg 抽帧 + sharp 编码的 webp 海报；
 *   2. 海报落盘缓存，第二次请求命中缓存（同一 ETag variant）；
 *   3. 视频海报不可用时返回 404，**绝不**把整个视频回退给 <img>
 *      （回退会让浏览器白下一段视频字节再报解码失败）。
 *
 * 依赖 ffmpeg-static + sharp：任一缺失时整组跳过，避免在没有 native
 * 依赖的 CI 上产生假失败。
 */
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-video-poster-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";

let app: Hono;
let getDb: () => DatabaseSync;
let closeDb: () => void;
let loginToken = "";
let posterEnabled = false;
let mp4Bytes: Buffer | null = null;

const USER_ID = "user-poster";
const NOTEBOOK_ID = "nb-poster";
const NOTE_ID = "note-poster";

function db() {
  return getDb();
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${loginToken}`, ...extra };
}

async function uploadVideo(bytes: Buffer, filename: string) {
  const form = new FormData();
  form.set("noteId", NOTE_ID);
  form.set("file", new File([new Uint8Array(bytes)], filename, { type: "video/mp4" }));
  const res = await app.request("/attachments", {
    method: "POST",
    headers: { "X-User-Id": USER_ID },
    body: form,
  });
  assert.equal(res.status, 201);
  return res.json() as Promise<{ id: string; url: string; mimeType: string; size: number }>;
}

test.before(async () => {
  const [attachmentsModule, schemaModule, authModule, thumbnailsModule, ffmpegModule] = await Promise.all([
    import("../src/routes/attachments"),
    import("../src/db/schema"),
    import("../src/lib/auth-security"),
    import("../src/services/thumbnails"),
    import("../src/lib/ffmpeg-path"),
  ]);
  app = new Hono();
  app.get("/attachments/:id", attachmentsModule.handleDownloadAttachment);
  app.route("/attachments", attachmentsModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NOTEBOOK_ID, USER_ID, "NB");
  db().prepare(`
    INSERT OR IGNORE INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(NOTE_ID, USER_ID, NOTEBOOK_ID, "Poster", "{}", "Poster");
  loginToken = authModule.signLoginToken({ userId: USER_ID, username: USER_ID, tokenVersion: 0 });

  posterEnabled = thumbnailsModule.isThumbnailEnabled();
  if (!posterEnabled) return;
  try {
    const file = path.join(tmpDir, "sample.mp4");
    execFileSync(ffmpegModule.getMediaFfmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y", "-nostdin",
      "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=10", "-t", "1",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", file,
    ], { windowsHide: true });
    mp4Bytes = fs.readFileSync(file);
  } catch {
    posterEnabled = false;
  }
});

test.after(() => {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发 EBUSY，交给系统临时目录回收 */
  }
});

test("video card request returns a webp poster", async (t) => {
  if (!posterEnabled || !mp4Bytes) return t.skip("ffmpeg / sharp 不可用");
  const uploaded = await uploadVideo(mp4Bytes, "clip.mp4");

  const res = await app.request(`/attachments/${uploaded.id}?w=240`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
  assert.equal(res.headers.get("x-thumbnail-width"), "240");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.ok(bytes.length > 200, "海报应当是非空 webp");
  assert.equal(
    Buffer.from(bytes.subarray(0, 4)).toString("latin1"),
    "RIFF",
    "webp 以 RIFF 头开始",
  );
  assert.equal(Buffer.from(bytes.subarray(8, 12)).toString("latin1"), "WEBP");
});

test("poster is cached on disk and served with a width-scoped ETag", async (t) => {
  if (!posterEnabled || !mp4Bytes) return t.skip("ffmpeg / sharp 不可用");
  const uploaded = await uploadVideo(mp4Bytes, "cached.mp4");
  const cachePath = path.join(tmpDir, "attachments", ".thumbs", `${uploaded.id}_w240.webp`);

  const first = await app.request(`/attachments/${uploaded.id}?w=240`, { headers: authHeaders() });
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  assert.ok(fs.existsSync(cachePath), "首次请求后应当留下 .thumbs 缓存");

  const second = await app.request(`/attachments/${uploaded.id}?w=240`, { headers: authHeaders() });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("etag"), first.headers.get("etag"));
  // variant 按宽度区分：480 不能复用 240 的验证器
  const wider = await app.request(`/attachments/${uploaded.id}?w=480`, { headers: authHeaders() });
  assert.equal(wider.status, 200);
  assert.notEqual(wider.headers.get("etag"), second.headers.get("etag"));
  await wider.arrayBuffer();
});

test("concurrent poster requests share one generation run", async (t) => {
  if (!posterEnabled || !mp4Bytes) return t.skip("ffmpeg / sharp 不可用");
  const a = await uploadVideo(mp4Bytes, "concurrent-a.mp4");
  const b = await uploadVideo(mp4Bytes, "concurrent-b.mp4");

  // 同一附件的并发卡片请求 + 不同附件的并发请求：串行队列不得死锁，
  // 并且每个请求都要拿到可用的海报。
  const responses = await Promise.all([
    app.request(`/attachments/${a.id}?w=240`, { headers: authHeaders() }),
    app.request(`/attachments/${a.id}?w=240`, { headers: authHeaders() }),
    app.request(`/attachments/${b.id}?w=240`, { headers: authHeaders() }),
  ]);
  const bodies = await Promise.all(responses.map(async (res) => {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    return res.arrayBuffer();
  }));
  assert.ok(bodies.every((bytes) => bytes.byteLength > 200));
  assert.deepEqual(
    new Uint8Array(bodies[0]),
    new Uint8Array(bodies[1]),
    "同一附件的并发请求应当返回完全相同的海报字节",
  );
});

test("broken video gets 404 instead of the whole file", async (t) => {
  if (!posterEnabled || !mp4Bytes) return t.skip("ffmpeg / sharp 不可用");
  const uploaded = await uploadVideo(Buffer.from("not a real mp4 at all"), "broken.mp4");

  const posterRes = await app.request(`/attachments/${uploaded.id}?w=240`, { headers: authHeaders() });
  assert.equal(posterRes.status, 404);
  const body = await posterRes.json() as { code?: string };
  assert.equal(body.code, "VIDEO_POSTER_UNAVAILABLE");

  // 同一附件的完整下载不受影响：仍然给原始字节
  const fullRes = await app.request(`/attachments/${uploaded.id}?download=1`, { headers: authHeaders() });
  assert.equal(fullRes.status, 200);
  assert.equal(fullRes.headers.get("content-type"), "video/mp4");
  assert.equal(fullRes.headers.get("content-disposition")?.includes("attachment"), true);
});

test("object-storage video never falls back to the whole file", async (t) => {
  if (!posterEnabled || !mp4Bytes) return t.skip("ffmpeg / sharp 不可用");
  const uploaded = await uploadVideo(mp4Bytes, "nas-clip.mp4");
  const { path: relPath } = db().prepare("SELECT path FROM attachments WHERE id = ?")
    .get(uploaded.id) as { path: string };
  // 模拟 NAS/S3 部署：本地目录里没有字节，内容只能走 readAttachmentObject
  fs.rmSync(path.join(tmpDir, "attachments", relPath), { force: true });

  const core = await import("../src/routes/attachments-core");
  const nasApp = new Hono();
  nasApp.get("/attachments/:id", (c) => core.handleDownloadAttachment(c, {
    readAttachmentObject: async () => mp4Bytes,
  }));

  // 卡片海报：宁可 404 让前端回退图标，也不能把整段视频交给 <img>
  const posterRes = await nasApp.request(`/attachments/${uploaded.id}?w=240`, {
    headers: { "X-User-Id": USER_ID },
  });
  assert.equal(posterRes.status, 404);
  await posterRes.arrayBuffer();

  // 完整访问仍然正常（详情抽屉播放 / 下载）
  const fullRes = await nasApp.request(`/attachments/${uploaded.id}?inline=1`, {
    headers: { "X-User-Id": USER_ID },
  });
  assert.equal(fullRes.status, 200);
  assert.equal(fullRes.headers.get("content-type"), "video/mp4");
  assert.ok((await fullRes.arrayBuffer()).byteLength > 0);
});

test("image thumbnails keep working unchanged", async (t) => {
  if (!posterEnabled) return t.skip("sharp 不可用");
  // 1x1 png
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const form = new FormData();
  form.set("noteId", NOTE_ID);
  form.set("file", new File([new Uint8Array(png)], "dot.png", { type: "image/png" }));
  const uploaded = await (await app.request("/attachments", {
    method: "POST", headers: { "X-User-Id": USER_ID }, body: form,
  })).json() as { id: string };

  const res = await app.request(`/attachments/${uploaded.id}?w=240`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
});
