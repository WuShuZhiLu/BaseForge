/**
 * 远程文件管理插件 —— 百度网盘提供方单测（mock fetch，不触网、无需真实 access_token）。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { baiduProvider } from "../src/services/remote-files/baidu";
import { RemoteProviderError } from "../src/services/remote-files/types";

const CTX = { baseUrl: "", username: "", password: "", rootPath: "/docs", accessToken: "tok-123" };

const LIST_OK = JSON.stringify({ errno: 0, list: [
  { fs_id: 1, path: "/docs/笔记/", server_filename: "笔记", isdir: 1, size: 0, server_mtime: 1760000000 },
  { fs_id: 2, path: "/docs/readme.md", server_filename: "readme.md", isdir: 0, size: 123, server_mtime: 1760000001 },
] });

interface MockResponse { match: (url: string) => boolean; status: number; body: string }
let responses: MockResponse[] = [];
let calls: Array<{ url: string; method: string; body?: unknown }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  responses = [];
  calls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, method: (init?.method || "GET").toUpperCase(), body: init?.body });
    const hit = responses.find((r) => r.match(url));
    if (!hit) throw new Error("no mock response for " + url);
    return new Response(hit.body, { status: hit.status });
  }) as any;
});

function ok(body: Record<string, unknown> = {}) { return JSON.stringify({ errno: 0, ...body }); }

describe("baidu provider", () => {
  it("list：请求参数与条目映射（剥 rootPath 前缀）", async () => {
    responses.push({ match: (u) => u.includes("method=list"), status: 200, body: LIST_OK });
    const entries = await baiduProvider.list(CTX, "");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("method=list"), "list method");
    assert.ok(calls[0].url.includes("access_token=tok-123"), "token in query");
    assert.ok(calls[0].url.includes(encodeURIComponent("/docs")), "dir encoded");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, "笔记");
    assert.equal(entries[0].path, "笔记", "no /docs prefix");
    assert.equal(entries[0].isFolder, true);
    assert.equal(entries[1].path, "readme.md");
    assert.equal(entries[1].size, 123);
  });

  it("list：errno=-6 映射为 token 失效提示", async () => {
    responses.push({ match: (u) => u.includes("method=list"), status: 200, body: JSON.stringify({ errno: -6 }) });
    await assert.rejects(
      () => baiduProvider.list(CTX, ""),
      (err: unknown) => err instanceof RemoteProviderError && /access_token 无效/.test(err.message),
    );
  });

  it("read：list→filemetas→dlink 三段取回文本", async () => {
    responses.push({ match: (u) => u.includes("method=list"), status: 200, body: LIST_OK });
    responses.push({ match: (u) => u.includes("method=filemetas"), status: 200, body: JSON.stringify({ errno: 0, list: [{ fs_id: 2, dlink: "https://pan.baidu.com/d/1/x" }] }) });
    responses.push({ match: (u) => u.includes("/d/1/x"), status: 200, body: "# hello baidu" });
    const result = await baiduProvider.read(CTX, "readme.md");
    assert.equal(result.content, "# hello baidu");
    assert.equal(result.size, 13);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].url.includes("method=filemetas"), "filemetas called");
  });

  it("write：superfile2 上传（multipart file 字段）", async () => {
    responses.push({ match: (u) => u.includes("superfile2"), status: 200, body: ok({ fs_id: 9 }) });
    await baiduProvider.write(CTX, "readme.md", "new md");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("method=upload"), "upload method");
    assert.ok(calls[0].url.includes(encodeURIComponent("/docs/readme.md")), "remote path encoded");
    assert.ok(calls[0].body instanceof FormData, "multipart body");
    assert.ok((calls[0].body as FormData).has("file"), "file field");
  });

  it("mkdir：method=create，errno=-8（已存在）视为成功", async () => {
    responses.push({ match: (u) => u.includes("method=create"), status: 200, body: JSON.stringify({ errno: -8 }) });
    await baiduProvider.mkdir(CTX, "新建目录");
    assert.ok(calls[0].url.includes("method=create"));
  });

  it("remove：filemanager delete", async () => {
    responses.push({ match: (u) => u.includes("a=delete"), status: 200, body: ok() });
    await baiduProvider.remove(CTX, "readme.md");
    assert.ok(calls[0].url.includes("a=delete"));
    assert.ok(calls[0].url.includes(encodeURIComponent(JSON.stringify(["/docs/readme.md"]))), "filelist payload");
  });

  it("rename：filemanager rename 带新名", async () => {
    responses.push({ match: (u) => u.includes("a=rename"), status: 200, body: ok() });
    await baiduProvider.rename(CTX, "readme.md", "renamed.md");
    assert.ok(calls[0].url.includes("a=rename"));
    assert.ok(calls[0].url.includes("renamed.md"), "new name in payload");
  });

  it("未配置 access_token 时给出明确错误", async () => {
    await assert.rejects(
      () => baiduProvider.list({ baseUrl: "", username: "", password: "", rootPath: "", accessToken: "" }, ""),
      (err: unknown) => err instanceof RemoteProviderError && /access_token/.test(err.message),
    );
  });

  it("writeBinary >4MB：precreate → 分片 → create 三段流", async () => {
    responses.push({ match: (u) => u.includes("method=precreate"), status: 200, body: ok({ uploadid: "UP123" }) });
    responses.push({ match: (u) => u.includes("superfile2"), status: 200, body: ok({ fs_id: 7 }) });
    responses.push({ match: (u) => u.includes("method=create"), status: 200, body: ok({ fs_id: 7 }) });
    const big = Buffer.alloc(4 * 1024 * 1024 + 100, 0x61);
    await baiduProvider.writeBinary(CTX, "big.md", big);
    assert.equal(calls.length, 4);
    assert.ok(calls[0].url.includes("method=precreate"), "precreate first");
    assert.equal((calls[0].body as URLSearchParams).get("path"), "/docs/big.md", "path in form body");
    assert.ok(calls[1].url.includes("partseq=0"), "part 0");
    assert.ok(calls[1].url.includes("uploadid=UP123"), "uploadid passed");
    assert.ok(calls[2].url.includes("partseq=1"), "part 1");
    assert.ok(calls[3].url.includes("method=create"), "create merge last");
  });

  it("writeBinary >4MB：precreate 失败直接报错", async () => {
    responses.push({ match: (u) => u.includes("method=precreate"), status: 200, body: JSON.stringify({ errno: 12 }) });
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x62);
    await assert.rejects(
      () => baiduProvider.writeBinary(CTX, "big.md", big),
      (err: unknown) => err instanceof RemoteProviderError && /errno=12/.test(err.message),
    );
    assert.equal(calls.length, 1, "no part upload after precreate failure");
  });
});
