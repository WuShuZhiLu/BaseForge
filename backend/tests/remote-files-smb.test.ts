/**
 * 远程文件管理插件 —— SMB 提供方单测（mock SMB2 客户端工厂，不触网）。
 * 路径键全部动态构造（BS = 反斜杠），规避源码转义歧义。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { parseSmbBaseUrl, setSmb2Factory, smbProvider, type Smb2ClientLike } from "../src/services/remote-files/smb";
import { RemoteProviderError } from "../src/services/remote-files/types";

const BS = String.fromCharCode(92);
const KEY_BMD = BS + "docs" + BS + "b.md";
const KEY_SUB = BS + "docs" + BS + "sub";
const KEY_ABMD = BS + "docs" + BS + "a" + BS + "b.md";
const KEY_OUT = BS + "docs" + BS + "out.bin";
const KEY_CMD = BS + "docs" + BS + "c.md";
const CTX = { baseUrl: "\\\\nas\\\\docs", username: "u", password: "p", rootPath: "/docs", domain: "WORKGROUP" };

interface Call { op: string; args: unknown[] }
let calls: Call[] = [];
let readdirResult: string[] = [];
let statMap: Record<string, { isDirectory(): boolean; size: number; mtime?: Date }> = {};
let readFileResult: Buffer = Buffer.alloc(0);

beforeEach(() => {
  calls = [];
  readdirResult = ["b.md", "sub"];
  statMap = {
    ["\\docs\\b.md"]: { isDirectory: () => false, size: 5, mtime: new Date("2026-10-19T00:00:00Z") },
    ["\\docs\\sub"]: { isDirectory: () => true, size: 0 },
  };
  readFileResult = Buffer.from("smb-content", "utf8");
  setSmb2Factory((cfg) => {
    calls.push({ op: "new", args: [cfg] });
    return {
      readdir: (p: string, cb: any) => { calls.push({ op: "readdir", args: [p] }); cb(null, p === KEY_SUB ? [] : readdirResult); },
      stat: (p: string, cb: any) => { calls.push({ op: "stat", args: [p] }); const st = statMap[p]; if (!st) cb({ code: "STATUS_OBJECT_NAME_NOT_FOUND" }); else cb(null, st); },
      readFile: (p: string, cb: any) => { calls.push({ op: "readFile", args: [p] }); cb(null, readFileResult); },
      writeFile: (p: string, data: Buffer, cb: any) => { calls.push({ op: "writeFile", args: [p, data] }); cb(null); },
      mkdir: (p: string, cb: any) => { calls.push({ op: "mkdir", args: [p] }); cb(null); },
      rename: (a: string, b: string, cb: any) => { calls.push({ op: "rename", args: [a, b] }); cb(null); },
      unlink: (p: string, cb: any) => { calls.push({ op: "unlink", args: [p] }); cb(null); },
      rmdir: (p: string, cb: any) => { calls.push({ op: "rmdir", args: [p] }); cb(null); },
      close: () => { calls.push({ op: "close", args: [] }); },
    } as Smb2ClientLike;
  });
});

describe("parseSmbBaseUrl", () => {
  it("UNC 与 smb:// 两种格式", () => {
    assert.deepEqual(parseSmbBaseUrl("\\\\192.168.1.10\\docs"), { share: "\\\\192.168.1.10\\docs", port: 445 });
    assert.deepEqual(parseSmbBaseUrl("smb://nas:4455/share/sub"), { share: "\\\\nas\\share\\sub", port: 4455 });
    assert.throws(() => parseSmbBaseUrl("\\\\onlyhost"), RemoteProviderError);
    assert.throws(() => parseSmbBaseUrl("smb://noshare"), RemoteProviderError);
  });
});

describe("smb provider", () => {
  it("list：readdir+stat，路径转换与排序（目录优先）", async () => {
    const entries = await smbProvider.list(CTX, "");
    assert.equal(entries[0].name, "sub");
    assert.equal(entries[0].isFolder, true);
    assert.equal(entries[0].path, "sub");
    assert.equal(entries[1].name, "b.md");
    assert.equal(entries[1].size, 5);
    assert.ok(calls.some((c) => c.op === "readdir" && c.args[0] === "\\docs"), "smb dir path");
    assert.ok(calls.some((c) => c.op === "close"), "client closed");
  });

  it("readBinary：readFile 返回 Buffer；read 转文本", async () => {
    const buffer = await smbProvider.readBinary(CTX, "a/b.md");
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.toString("utf8"), "smb-content");
    assert.equal(calls.find((c) => c.op === "readFile")?.args[0], "\\docs\\a\\b.md");
    const text = await smbProvider.read(CTX, "a/b.md");
    assert.equal(text.content, "smb-content");
  });

  it("writeBinary：writeFile 写入；write 走 Buffer", async () => {
    await smbProvider.writeBinary(CTX, "out.bin", Buffer.from("bin", "utf8"));
    const call = calls.find((c) => c.op === "writeFile");
    assert.equal(call?.args[0], "\\docs\\out.bin");
    assert.equal((call?.args[1] as Buffer).toString("utf8"), "bin");
    await smbProvider.write(CTX, "out.txt", "hello");
    const w = calls.filter((c) => c.op === "writeFile").pop();
    assert.equal((w?.args[1] as Buffer).toString("utf8"), "hello");
  });

  it("mkdir / rename：路径与目标正确", async () => {
    await smbProvider.mkdir(CTX, "新建目录");
    assert.equal(calls.find((c) => c.op === "mkdir")?.args[0], BS + "docs" + BS + "新建目录");
    await smbProvider.rename(CTX, "b.md", "c.md");
    const r = calls.find((c) => c.op === "rename");
    assert.equal(r?.args[0], "\\docs\\b.md");
    assert.equal(r?.args[1], "\\docs\\c.md");
  });

  it("remove：目录递归删除，文件 unlink", async () => {
    await smbProvider.remove(CTX, "sub");
    assert.ok(calls.some((c) => c.op === "rmdir" && c.args[0] === "\\docs\\sub"));
    await smbProvider.remove(CTX, "b.md");
    assert.ok(calls.some((c) => c.op === "unlink" && c.args[0] === "\\docs\\b.md"));
  });

  it("stat 缺失时 list 不中断（降级条目）", async () => {
    statMap = {};
    const entries = await smbProvider.list(CTX, "");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].size, 0);
  });
});
