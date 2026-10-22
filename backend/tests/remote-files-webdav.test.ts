/**
 * 远程文件管理插件 —— 路径工具 / 凭据加密 / WebDAV 提供方单测。
 * 全部 mock fetch，不触网、不依赖数据库。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  isProbablyTextFile,
  joinRemotePath,
  normalizeRemotePath,
  toRelativePath,
} from "../src/services/remote-files/types";
import { webdavProvider } from "../src/services/remote-files/webdav";
import { decryptSecret, encryptSecret } from "../src/services/remote-files/credentials";

const CTX = { baseUrl: "https://dav.example.com", username: "u", password: "p", rootPath: "/docs" };

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/docs/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/docs/%E7%AC%94%E8%AE%B0/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Mon, 19 Oct 2026 08:00:00 GMT</d:getlastmodified></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/docs/readme.md</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>123</d:getcontentlength><d:getlastmodified>Mon, 19 Oct 2026 07:00:00 GMT</d:getlastmodified></d:prop></d:propstat>
  </d:response>
</d:multistatus>`;

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let lastRequest: CapturedRequest | null = null;
let nextStatus = 207;
let nextBody = MULTISTATUS;

const realFetch = globalThis.fetch;

beforeEach(() => {
  lastRequest = null;
  nextStatus = 207;
  nextBody = MULTISTATUS;
  globalThis.fetch = (async (_input: any, init?: any) => {
    lastRequest = {
      url: String(_input),
      method: (init?.method || "GET").toUpperCase(),
      headers: init?.headers || {},
      body: init?.body,
    };
    return new Response(nextBody, { status: nextStatus });
  }) as any;
});

describe("remote-files 路径工具", () => {
  it("normalizeRemotePath：折叠斜杠、拒绝越界", () => {
    assert.equal(normalizeRemotePath("/a//b/"), "a/b");
    assert.equal(normalizeRemotePath(""), "");
    assert.throws(() => normalizeRemotePath(".."));
    assert.throws(() => normalizeRemotePath("a/../b"));
  });

  it("joinRemotePath：拼 rootPath 且以 / 开头", () => {
    assert.equal(joinRemotePath("/docs", "a/b.md"), "/docs/a/b.md");
    assert.equal(joinRemotePath("", "a"), "/a");
    assert.equal(joinRemotePath("/docs", ""), "/docs");
  });

  it("toRelativePath：解码并去 root 前缀", () => {
    assert.equal(toRelativePath("/docs", "/docs/%E7%AC%94%E8%AE%B0/"), "笔记");
    assert.equal(toRelativePath("/docs", "/docs/readme.md"), "readme.md");
    assert.equal(toRelativePath("/docs", "/docs/"), "");
  });

  it("isProbablyTextFile：文本扩展判定", () => {
    assert.equal(isProbablyTextFile("readme.md"), true);
    assert.equal(isProbablyTextFile("Makefile"), true);
    assert.equal(isProbablyTextFile("photo.png"), false);
  });
});

describe("remote-files 凭据加密", () => {
  it("encrypt/decrypt 往返一致，篡改后解密为空", () => {
    const enc = encryptSecret("secret-value");
    assert.notEqual(enc, "secret-value");
    assert.equal(decryptSecret(enc), "secret-value");
    const tampered = enc.slice(0, -4) + "AAAA";
    assert.equal(decryptSecret(tampered), "");
    assert.equal(decryptSecret(""), "");
  });
});

describe("webdav provider", () => {
  it("list：PROPFIND Depth:1，解析多状态 XML", async () => {
    const entries = await webdavProvider.list(CTX, "");
    assert.equal(lastRequest?.method, "PROPFIND");
    assert.equal(lastRequest?.url, "https://dav.example.com/docs");
    assert.equal((lastRequest?.headers as any)?.Depth, "1");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, "笔记");
    assert.equal(entries[0].path, "笔记");
    assert.equal(entries[0].isFolder, true);
    assert.equal(entries[1].name, "readme.md");
    assert.equal(entries[1].path, "readme.md");
    assert.equal(entries[1].isFolder, false);
    assert.equal(entries[1].size, 123);
  });

  it("read：GET 正文", async () => {
    nextStatus = 200;
    nextBody = "hello dav";
    const result = await webdavProvider.read(CTX, "readme.md");
    assert.equal(lastRequest?.method, "GET");
    assert.equal(lastRequest?.url, "https://dav.example.com/docs/readme.md");
    assert.equal(result.content, "hello dav");
    assert.equal(result.size, 9);
  });

  it("write：PUT 写回", async () => {
    nextStatus = 201;
    await webdavProvider.write(CTX, "readme.md", "new content");
    assert.equal(lastRequest?.method, "PUT");
    // write 内部走 writeBinary：PUT body 为 utf8 Buffer
    assert.ok(Buffer.isBuffer(lastRequest?.body));
    assert.equal((lastRequest?.body as Buffer).toString("utf8"), "new content");
  });

  it("readBinary：GET 返回 Buffer", async () => {
    nextStatus = 200;
    nextBody = "raw-bytes";
    const buffer = await webdavProvider.readBinary(CTX, "img.png");
    assert.equal(lastRequest?.method, "GET");
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.toString("utf8"), "raw-bytes");
  });

  it("writeBinary：PUT 写入 Buffer", async () => {
    nextStatus = 201;
    await webdavProvider.writeBinary(CTX, "img.png", Buffer.from("bin-data", "utf8"));
    assert.equal(lastRequest?.method, "PUT");
    assert.ok(Buffer.isBuffer(lastRequest?.body));
    assert.equal((lastRequest?.body as Buffer).toString("utf8"), "bin-data");
  });

  it("401 映射为认证失败提示", async () => {
    nextStatus = 401;
    await assert.rejects(() => webdavProvider.list(CTX, ""), /认证失败/);
  });
});
