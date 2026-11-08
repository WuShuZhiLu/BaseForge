/**
 * 远程文件管理 —— 路径工具 / 凭据加密 / WebDAV 提供方单测。
 *
 * WebDAV 走库内部的 node-fetch（不是全局 fetch），所以用 getPatcher() 注入假 fetch：
 * 不触网、不依赖数据库。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { getPatcher } from "webdav";

import {
  isProbablyTextFile,
  joinRemotePath,
  normalizeRemotePath,
  toRelativePath,
  type RemoteProviderContext,
} from "../src/services/remote-files/types";
import { webdavProvider } from "../src/services/remote-files/webdav";
import { decryptSecret, encryptSecret } from "../src/services/remote-files/credentials";

/** 单根：baseUrl + /docs */
const CTX: RemoteProviderContext = { baseUrl: "https://dav.example.com", username: "u", password: "p", rootPath: "/docs" };

/** 多根：路径第一段是别名，对应远端绝对路径 */
const MULTI_CTX: RemoteProviderContext = {
  baseUrl: "https://dav.example.com",
  username: "u",
  password: "p",
  rootPath: "",
  rootPaths: [
    { name: "docs", path: "/data/docs" },
    { name: "media", path: "/media" },
  ],
};

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface DavItem {
  href: string;
  dir?: boolean;
  size?: number;
  modified?: string;
}

function multistatus(items: DavItem[]): string {
  const body = items
    .map((item) => {
      const type = item.dir ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/>";
      const size = typeof item.size === "number" ? `<d:getcontentlength>${item.size}</d:getcontentlength>` : "";
      const modified = item.modified ? `<d:getlastmodified>${item.modified}</d:getlastmodified>` : "";
      return `<d:response><d:href>${item.href}</d:href><d:propstat><d:prop>${type}${size}${modified}</d:prop></d:propstat></d:response>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;
}

const DOCS_LIST = multistatus([
  { href: "/docs/", dir: true },
  { href: "/docs/%E7%AC%94%E8%AE%B0/", dir: true, modified: "Mon, 19 Oct 2026 08:00:00 GMT" },
  { href: "/docs/readme.md", size: 123, modified: "Mon, 19 Oct 2026 07:00:00 GMT" },
]);

/** 收到请求前的状态；responder 返回 Response 时优先生效 */
let lastRequest: CapturedRequest | null = null;
let nextStatus = 207;
let nextBody = DOCS_LIST;
let responder: ((req: CapturedRequest) => Response | null) | null = null;

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  const maybe = input as { url?: unknown } | null;
  return maybe && typeof maybe.url === "string" ? maybe.url : String(input);
}

function headerOf(name: string): string | undefined {
  const headers = lastRequest?.headers || {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

getPatcher().patch("fetch", (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
  lastRequest = {
    url: urlOf(input),
    method: String(init?.method || "GET").toUpperCase(),
    headers: init?.headers || {},
    body: init?.body,
  };
  const custom = responder?.(lastRequest);
  if (custom) return custom;
  return new Response(nextBody, { status: nextStatus });
}) as never);

beforeEach(() => {
  lastRequest = null;
  nextStatus = 207;
  nextBody = DOCS_LIST;
  responder = null;
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

describe("webdav provider 单根", () => {
  it("list：PROPFIND Depth:1，解析多状态 XML", async () => {
    const entries = await webdavProvider.list(CTX, "");
    assert.equal(lastRequest?.method, "PROPFIND");
    assert.equal(lastRequest?.url, "https://dav.example.com/docs");
    assert.equal(headerOf("Depth"), "1");
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

  it("readBinary：GET 返回 Buffer", async () => {
    nextStatus = 200;
    nextBody = "raw-bytes";
    const buffer = await webdavProvider.readBinary(CTX, "img.png");
    assert.equal(lastRequest?.method, "GET");
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.toString("utf8"), "raw-bytes");
  });

  it("write：PUT 写入 Buffer", async () => {
    nextStatus = 201;
    await webdavProvider.write(CTX, "readme.md", "new content");
    assert.equal(lastRequest?.method, "PUT");
    assert.ok(Buffer.isBuffer(lastRequest?.body));
    assert.equal((lastRequest?.body as Buffer).toString("utf8"), "new content");
  });

  it("mkdir：405 视为目录已存在", async () => {
    nextStatus = 201;
    nextBody = "";
    await webdavProvider.mkdir(CTX, "新目录");
    assert.equal(lastRequest?.method, "MKCOL");

    nextStatus = 405;
    await assert.rejects(() => webdavProvider.mkdir(CTX, "新目录"), /目录已存在/);
  });

  it("rename：MOVE 到同目录新名", async () => {
    nextStatus = 201;
    nextBody = "";
    await webdavProvider.rename(CTX, "old.md", "new.md");
    assert.equal(lastRequest?.method, "MOVE");
    assert.equal(lastRequest?.url, "https://dav.example.com/docs/old.md");
    assert.equal(decodeURIComponent(headerOf("Destination") || ""), "https://dav.example.com/docs/new.md");
  });

  it("remove：整删 409 时逐层删子项", async () => {
    const deleted: string[] = [];
    const rootUrl = "https://dav.example.com/docs/sub";
    responder = (req) => {
      if (req.method === "PROPFIND") {
        return new Response(
          multistatus([
            { href: "/docs/sub/", dir: true },
            { href: "/docs/sub/a.md", size: 1 },
            { href: "/docs/sub/b.md", size: 1 },
          ]),
          { status: 207 },
        );
      }
      if (req.method === "DELETE") {
        deleted.push(req.url);
        // 目录非空时第一次整删 409；子项清空后再删就成功
        const isRoot = req.url === rootUrl;
        const firstRootDelete = isRoot && deleted.filter((url) => url === rootUrl).length === 1;
        return new Response(null, { status: firstRootDelete ? 409 : 204 });
      }
      return null;
    };
    await webdavProvider.remove(CTX, "sub");
    assert.deepEqual(deleted, [rootUrl, `${rootUrl}/a.md`, `${rootUrl}/b.md`, rootUrl]);
  });

  it("401 映射为认证失败提示", async () => {
    nextStatus = 401;
    nextBody = "";
    await assert.rejects(() => webdavProvider.list(CTX, ""), /认证失败/);
  });

  it("404 映射为文件或目录不存在", async () => {
    nextStatus = 404;
    nextBody = "";
    await assert.rejects(() => webdavProvider.read(CTX, "gone.md"), /不存在/);
  });
});

describe("webdav provider 多根", () => {
  it("虚拟根：只列别名，不发请求", async () => {
    const entries = await webdavProvider.list(MULTI_CTX, "");
    assert.equal(lastRequest, null);
    assert.deepEqual(entries.map((entry) => entry.path), ["docs", "media"]);
    assert.ok(entries.every((entry) => entry.isFolder));
  });

  it("别名：请求打到该根的远端路径，子项带别名前缀", async () => {
    nextBody = multistatus([
      { href: "/data/docs/", dir: true },
      { href: "/data/docs/readme.md", size: 5 },
    ]);
    const entries = await webdavProvider.list(MULTI_CTX, "docs");
    assert.equal(lastRequest?.url, "https://dav.example.com/data/docs");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, "docs/readme.md");
  });

  it("未知别名按 404 处理", async () => {
    await assert.rejects(() => webdavProvider.list(MULTI_CTX, "nope"), /根目录列表/);
  });

  it("虚拟根不可直接读写", async () => {
    await assert.rejects(() => webdavProvider.read(MULTI_CTX, ""), /请先选择/);
  });
});
