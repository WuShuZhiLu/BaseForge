/**
 * 远程文件凭据加密：独立密钥文件（.remote_secret_key）+ 历史 v1 兼容 + 解不开的显式判定。
 *
 * 背景：原来用 scrypt(JWT_SECRET) 派生密钥，JWT_SECRET 缺失时回退到源码常量，且备份包带
 * .jwt_secret —— 等于把解凭据的钥匙一起送出去；轮换 / 换机后所有密码静默解成空串。
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dataDir = "";
let credentials: typeof import("../src/services/remote-files/credentials");

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baseforge-remote-cred-"));
  process.env.ELECTRON_USER_DATA = dataDir;
  delete process.env.JWT_SECRET;
  credentials = await import("../src/services/remote-files/credentials");
});

after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("remote-files credentials", () => {
  it("加解密往返，且密文是 v2 前缀", () => {
    const enc = credentials.encryptSecret("p@ssw0rd-中文");
    assert.ok(enc.startsWith("v2:"), enc);
    assert.equal(credentials.decryptSecret(enc), "p@ssw0rd-中文");
    assert.equal(credentials.hasUnreadableSecret(enc), false);
    assert.equal(credentials.isLegacySecret(enc), false);
  });

  it("空值不产生密文", () => {
    assert.equal(credentials.encryptSecret(""), "");
    assert.equal(credentials.decryptSecret(""), "");
    assert.equal(credentials.hasUnreadableSecret(""), false);
  });

  it("密钥来自独立文件，不跟 JWT_SECRET 绑定", () => {
    const keyFile = path.join(dataDir, ".remote_secret_key");
    assert.equal(fs.existsSync(keyFile), true);
    assert.equal(fs.readFileSync(keyFile).length, 32);
    const enc = credentials.encryptSecret("abc");
    // 换 JWT_SECRET 不应影响解密
    process.env.JWT_SECRET = "a-completely-different-secret-value";
    try {
      assert.equal(credentials.decryptSecret(enc), "abc");
    } finally {
      delete process.env.JWT_SECRET;
    }
  });

  it("历史 v1 密文仍可解密，并可升级为 v2", () => {
    // 构造一条按老方案（scrypt(JWT_SECRET, "baseforge-remote-files-v1")）加密的密文
    const legacyKey = crypto.scryptSync(
      "baseforge-remote-files-development-key",
      "baseforge-remote-files-v1",
      32,
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
    const payload = Buffer.concat([cipher.update("legacy-pass", "utf8"), cipher.final()]);
    const legacy = `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${payload.toString("base64")}`;

    assert.equal(credentials.isLegacySecret(legacy), true);
    assert.equal(credentials.decryptSecret(legacy), "legacy-pass");

    const upgraded = credentials.upgradeSecret(legacy);
    assert.ok(upgraded.startsWith("v2:"));
    assert.equal(credentials.decryptSecret(upgraded), "legacy-pass");
  });

  it("解不开的密文（换机 / 换密钥）标记为 unreadable 而不是静默当空密码", () => {
    const broken = `v2:${crypto.randomBytes(12).toString("base64")}:${crypto.randomBytes(16).toString("base64")}:${crypto.randomBytes(8).toString("base64")}`;
    assert.equal(credentials.decryptSecret(broken), "");
    assert.equal(credentials.hasUnreadableSecret(broken), true);
  });
});
