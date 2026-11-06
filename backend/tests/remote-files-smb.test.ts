/**
 * 远程文件管理 —— SMB 提供方单测（mock smb3-client 工厂，不触网）。
 * 路径用正斜杠：第一段是共享名，其余为共享内路径。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  parseSmbBaseUrl,
  parseSmbTarget,
  setSmbClientFactory,
  smbProvider,
  type SmbClientLike,
} from "../src/services/remote-files/smb";
import { RemoteProviderError } from "../src/services/remote-files/types";

const CTX = { baseUrl: "\\\\nas\\docs", username: "u", password: "p", rootPath: "", domain: "WORKGROUP" };

interface Call { op: string; args: unknown[] }
let calls: Call[] = [];
let direntResult: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> = [];
let statMap: Record<string, { isDirectory: boolean; size: number; mtime?: Date }> = {};
let readFileResult: Buffer = Buffer.alloc(0);

const dirent = (name: string, isDirectory: boolean) => ({
  name,
  isFile: () => !isDirectory,
  isDirectory: () => isDirectory,
});

beforeEach(() => {
  calls = [];
  direntResult = [dirent("b.md", false), dirent("sub", true)];
  statMap = {
    "docs/b.md": { isDirectory: false, size: 5, mtime: new Date("2026-10-19T00:00:00Z") },
    "docs/sub": { isDirectory: true, size: 0 },
  };
  readFileResult = Buffer.from("smb-content", "utf8");
  setSmbClientFactory(async (cfg) => {
    calls.push({ op: "new", args: [cfg] });
    return {
      readdir: async (p: string, opts?: unknown) => {
        calls.push({ op: "readdir", args: [p, opts] });
        return p === "docs/sub" ? [] : direntResult;
      },
      stat: async (p: string) => {
        calls.push({ op: "stat", args: [p] });
        const st = statMap[p];
        if (!st) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return st;
      },
      readFile: async (p: string) => {
        calls.push({ op: "readFile", args: [p] });
        return readFileResult;
      },
      writeFile: async (p: string, data: Buffer | string) => { calls.push({ op: "writeFile", args: [p, data] }); },
      mkdir: async (p: string) => { calls.push({ op: "mkdir", args: [p] }); },
      rm: async (p: string) => { calls.push({ op: "unlink", args: [p] }); },
      rmdir: async (p: string) => { calls.push({ op: "rmdir", args: [p] }); },
      rename: async (a: string, b: string) => { calls.push({ op: "rename", args: [a, b] }); },
      close: async () => { calls.push({ op: "close", args: [] }); },
    } as SmbClientLike;
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

describe("parseSmbTarget", () => {
  it("拆出主机、端口与共享名", () => {
    assert.deepEqual(parseSmbTarget("\\\\192.168.100.3\\workspace"), {
      host: "192.168.100.3", port: 445, shareName: "workspace",
    });
    assert.deepEqual(parseSmbTarget("smb://nas:4455/share/sub"), {
      host: "nas", port: 4455, shareName: "share",
    });
    assert.throws(() => parseSmbTarget("\\\\onlyhost"), RemoteProviderError);
  });
});

describe("smb provider", () => {
  it("空域 / 空用户名时仍向客户端传字符串，避免认证阶段崩溃", async () => {
    await smbProvider.list({ baseUrl: "\\\\nas\\docs", username: "", password: "", rootPath: "" }, "");
    const cfg = calls.find((c) => c.op === "new")?.args[0] as Record<string, unknown>;
    assert.equal(typeof cfg.domain, "string", "domain 不能是 undefined");
    assert.equal(cfg.domain, "");
    assert.equal(typeof cfg.username, "string", "username 不能是 undefined");
    assert.equal(typeof cfg.password, "string", "password 不能是 undefined");
  });

  it("连接 / 认证失败转成业务错误，不冒泡成 500", async () => {
    setSmbClientFactory(async () => {
      throw Object.assign(new Error("SESSION_SETUP AUTH failed"), { code: "AUTH" });
    });
    await assert.rejects(
      smbProvider.list(CTX, ""),
      (err: unknown) => err instanceof RemoteProviderError && err.status === 403,
    );
  });

  it("list：根目录传共享名而非空路径，排序且目录优先", async () => {
    const entries = await smbProvider.list(CTX, "");
    assert.equal(entries[0].name, "sub");
    assert.equal(entries[0].isFolder, true);
    assert.equal(entries[0].path, "sub");
    assert.equal(entries[1].name, "b.md");
    assert.equal(entries[1].size, 5);
    assert.ok(calls.some((c) => c.op === "readdir" && c.args[0] === "docs"), "根目录路径 = 共享名");
    assert.ok(calls.some((c) => c.op === "close"), "client closed");
  });

  it("readBinary：readFile 返回 Buffer；read 转文本", async () => {
    const buffer = await smbProvider.readBinary(CTX, "a/b.md");
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.toString("utf8"), "smb-content");
    assert.equal(calls.find((c) => c.op === "readFile")?.args[0], "docs/a/b.md");
    const text = await smbProvider.read(CTX, "a/b.md");
    assert.equal(text.content, "smb-content");
  });

  it("writeBinary：writeFile 写入；write 走 Buffer", async () => {
    await smbProvider.writeBinary(CTX, "out.bin", Buffer.from("bin", "utf8"));
    const call = calls.find((c) => c.op === "writeFile");
    assert.equal(call?.args[0], "docs/out.bin");
    assert.equal((call?.args[1] as Buffer).toString("utf8"), "bin");
    await smbProvider.write(CTX, "out.txt", "hello");
    const w = calls.filter((c) => c.op === "writeFile").pop();
    assert.equal((w?.args[1] as Buffer).toString("utf8"), "hello");
  });

  it("mkdir / rename：路径与目标正确", async () => {
    await smbProvider.mkdir(CTX, "新建目录");
    assert.equal(calls.find((c) => c.op === "mkdir")?.args[0], "docs/新建目录");
    await smbProvider.rename(CTX, "b.md", "c.md");
    const r = calls.find((c) => c.op === "rename");
    assert.equal(r?.args[0], "docs/b.md");
    assert.equal(r?.args[1], "docs/c.md");
  });

  it("remove：目录递归删除，文件 rm", async () => {
    await smbProvider.remove(CTX, "sub");
    assert.ok(calls.some((c) => c.op === "rmdir" && c.args[0] === "docs/sub"));
    await smbProvider.remove(CTX, "b.md");
    assert.ok(calls.some((c) => c.op === "unlink" && c.args[0] === "docs/b.md"));
  });

  it("stat 缺失时 list 不中断（降级条目）", async () => {
    statMap = {};
    const entries = await smbProvider.list(CTX, "");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].size, 0);
  });
});

/** 一个设备上文件分散在多个共享：虚拟根 + 路径第一段即共享名（用户实测提出的用法）。 */
describe("smb 多共享（虚拟根）", () => {
  const MULTI = {
    baseUrl: "",
    host: "nas",
    shares: ["docs", "media"],
    username: "",
    password: "",
    rootPath: "",
    domain: "",
  };

  it("根目录把配置的共享并列成文件夹，且不建立连接", async () => {
    const entries = await smbProvider.list(MULTI, "");
    assert.deepEqual(entries.map((entry) => entry.name), ["docs", "media"]);
    assert.ok(entries.every((entry) => entry.isFolder));
    assert.equal(entries[0].path, "docs");
    assert.equal(calls.length, 0, "虚拟根不需要连服务器");
  });

  it("路径第一段解析成共享名，返回路径也带共享前缀", async () => {
    direntResult = [dirent("b.md", false)];
    statMap = { "media/b.md": { isDirectory: false, size: 7 } };
    const entries = await smbProvider.list(MULTI, "media");
    assert.ok(calls.some((call) => call.op === "readdir" && call.args[0] === "media"));
    assert.equal(entries[0].path, "media/b.md");
    assert.equal(entries[0].size, 7);
  });

  it("读写落在对应共享下", async () => {
    await smbProvider.write(MULTI, "docs/sub/a.md", "hi");
    const w = calls.filter((call) => call.op === "writeFile").pop();
    assert.equal(w?.args[0], "docs/sub/a.md");
  });

  it("不在共享列表里的第一段报 404，而不是拼成畸形路径", async () => {
    await assert.rejects(
      smbProvider.read(MULTI, "unknown/a.md"),
      (err: unknown) => err instanceof RemoteProviderError && err.status === 404,
    );
  });
});
