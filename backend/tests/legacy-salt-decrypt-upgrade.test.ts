/**
 * 问题 3.2：六处加密盐改名后，存量（nowen 盐派生）密文解不开。
 *
 * 修复方案：解密先试新盐（baseforge-*）、失败再试旧盐（nowen-*）；
 * 成功解出明文后由读取方用新盐重写落库（幂等升级），失败保持原值。
 *
 * 本文件构造"按旧盐加密"的样例密文，验证：
 * 1. 旧盐密文可解密；
 * 2. 读取方会把落库密文升级成新盐密文，且重复读取幂等。
 */
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import { getDb } from "../src/db/schema";
import { readSmtpConfig } from "../src/services/email";
import { readObjectStorageConfigPublic } from "../src/services/attachment-storage";
import { testBackupWebDavConnection, getBackupWebDavConfig, decryptSecretDetailed as webdavDecrypt } from "../src/services/backup-webdav";
import { createExportTarget, listExportTargets } from "../src/services/calendar-export";
import {
  encryptSecret as remoteEncryptSecret,
  decryptSecret as remoteDecryptSecret,
  isLegacySecret as remoteIsLegacySecret,
  upgradeSecret as remoteUpgradeSecret,
} from "../src/services/remote-files/credentials";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JWT_SECRET = "legacy-salt-upgrade-test-secret-value";

function sealWith(salt: string, secretSource: string, plain: string): string {
  const key = crypto.scryptSync(secretSource, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

function openWith(salt: string, secretSource: string, encoded: string): string {
  const [, ivB64, tagB64, dataB64] = encoded.split(":");
  const key = crypto.scryptSync(secretSource, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

function readSetting(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

test("email：旧盐密文可解密，读取后用新盐重写且幂等", () => {
  process.env.JWT_SECRET = JWT_SECRET;
  const plain = "smtp-legacy-pass";
  const legacyEnc = sealWith("nowen-smtp-v1", JWT_SECRET, plain);
  getDb()
    .prepare(
      "INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run("smtp:config", JSON.stringify({ enabled: true, host: "smtp.test", port: 465, username: "u", passwordEnc: legacyEnc }));

  const cfg = readSmtpConfig();
  assert.equal(cfg.password, plain);

  const upgraded = JSON.parse(readSetting("smtp:config")!) as { passwordEnc: string };
  assert.notEqual(upgraded.passwordEnc, legacyEnc, "落库密文应已用新盐重写");
  assert.equal(openWith("baseforge-smtp-v1", JWT_SECRET, upgraded.passwordEnc), plain, "新盐可解出同一明文");

  // 幂等：再次读取不再改写
  readSmtpConfig();
  assert.deepEqual(JSON.parse(readSetting("smtp:config")!), upgraded);
});

test("attachment-storage：旧盐密文可解密，读取后用新盐重写且幂等", () => {
  process.env.JWT_SECRET = JWT_SECRET;
  const plain = "s3-legacy-secret";
  const legacyEnc = sealWith("nowen-attachment-storage-v1", JWT_SECRET, plain);
  getDb()
    .prepare(
      "INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(
      "attachmentStorage:config",
      JSON.stringify({ enabled: true, endpoint: "https://s3.test", bucket: "b", accessKeyId: "ak", secretAccessKeyEnc: legacyEnc }),
    );

  const cfg = readObjectStorageConfigPublic();
  // 公开配置不回传明文密钥；解密成功才会 secretAccessKeySet = true
  assert.equal(cfg.secretAccessKeySet, true);

  const upgraded = JSON.parse(readSetting("attachmentStorage:config")!) as { secretAccessKeyEnc: string };
  assert.notEqual(upgraded.secretAccessKeyEnc, legacyEnc);
  assert.equal(openWith("baseforge-attachment-storage-v1", JWT_SECRET, upgraded.secretAccessKeyEnc), plain);

  readObjectStorageConfigPublic();
  assert.deepEqual(JSON.parse(readSetting("attachmentStorage:config")!), upgraded);
});

test("calendar-export：旧盐密文可解密，读取后用新盐重写且幂等", () => {
  process.env.JWT_SECRET = JWT_SECRET;
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('cal-u1', 'cal-u1', 'x')").run();
  db.prepare(
    "INSERT INTO task_calendar_feeds (id, userId, token) VALUES ('cal-feed-1', 'cal-u1', 'cal-feed-token-1')",
  ).run();
  const created = createExportTarget("cal-u1", {
    feedId: "cal-feed-1",
    endpoint: "https://s3.test",
    bucket: "b",
    accessKeyId: "ak",
    secretAccessKey: "placeholder",
    publicBaseUrl: "https://cdn.test",
  });

  const plain = "calendar-legacy-secret";
  const legacyEnc = sealWith("nowen-calendar-export-v1", JWT_SECRET, plain);
  db.prepare("UPDATE calendar_export_targets SET configJson = ? WHERE id = ?").run(
    JSON.stringify({ endpoint: "https://s3.test", bucket: "b", accessKeyId: "ak", secretAccessKeyEnc: legacyEnc, publicBaseUrl: "https://cdn.test" }),
    created.id,
  );

  const listed = listExportTargets("cal-u1");
  // 公开视图不回传明文密钥；解密成功才会 secretAccessKeySet = true
  assert.equal(listed[0].secretAccessKeySet, true);

  const upgraded = JSON.parse(
    (db.prepare("SELECT configJson FROM calendar_export_targets WHERE id = ?").get(created.id) as { configJson: string }).configJson,
  ) as { secretAccessKeyEnc: string };
  assert.notEqual(upgraded.secretAccessKeyEnc, legacyEnc);
  assert.equal(openWith("baseforge-calendar-export-v1", JWT_SECRET, upgraded.secretAccessKeyEnc), plain);

  listExportTargets("cal-u1");
  const after = (db.prepare("SELECT configJson FROM calendar_export_targets WHERE id = ?").get(created.id) as { configJson: string }).configJson;
  assert.equal(JSON.parse(after).secretAccessKeyEnc, upgraded.secretAccessKeyEnc);
});

test("backup-webdav：旧盐密文可解密，连接测试路径会用新盐重写且幂等", async () => {
  const WEBDAV_KEY = "legacy-salt-webdav-test-key-value";
  process.env.BACKUP_WEBDAV_ENCRYPTION_KEY = WEBDAV_KEY;
  const plain = "webdav-legacy-pass";
  const legacyEnc = sealWith("nowen-backup-webdav-v1", WEBDAV_KEY, plain);
  getDb()
    .prepare(
      "INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(
      "backup:webdav",
      JSON.stringify({ enabled: true, endpoint: "https://dav.test/root", username: "u", passwordEnc: legacyEnc, remotePath: "backups" }),
    );

  // 单测解密路径
  assert.equal(webdavDecrypt(legacyEnc).plain, plain);

  // 连接测试路径触发重写（fetch 打桩，不走网络；PROPFIND→207、MKCOL→201）
  const davFetch = (async (url: RequestInfo | URL, init?: RequestInit) =>
    new Response('<multistatus xmlns="DAV:"/>', { status: (init as { method?: string } | undefined)?.method === "MKCOL" ? 201 : 207 })) as typeof fetch;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = davFetch;
  try {
    await testBackupWebDavConnection();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const upgraded = JSON.parse(readSetting("backup:webdav")!) as { passwordEnc: string };
  assert.notEqual(upgraded.passwordEnc, legacyEnc);
  assert.equal(openWith("baseforge-backup-webdav-v1", WEBDAV_KEY, upgraded.passwordEnc), plain);

  // 幂等：再次连接测试不再改写
  globalThis.fetch = davFetch;
  try {
    await testBackupWebDavConnection();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(JSON.parse(readSetting("backup:webdav")!), upgraded);
  assert.equal(getBackupWebDavConfig().passwordSet, true);
});

test("remote-files：旧盐（nowen）v1 密文可解密，并可升级为 v2", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-salt-remote-"));
  const previous = process.env.ELECTRON_USER_DATA;
  process.env.ELECTRON_USER_DATA = dataDir;
  process.env.JWT_SECRET = JWT_SECRET;
  try {
    const plain = "remote-legacy-pass";
    const legacyEnc = sealWith("nowen-remote-files-v1", JWT_SECRET, plain);
    assert.equal(remoteIsLegacySecret(legacyEnc), true);
    assert.equal(remoteDecryptSecret(legacyEnc), plain);

    const upgraded = remoteUpgradeSecret(legacyEnc);
    assert.ok(upgraded.startsWith("v2:"));
    assert.equal(remoteDecryptSecret(upgraded), plain);
    assert.notEqual(upgraded, remoteEncryptSecret("other"));

    // 新盐加密往返不受影响
    const fresh = remoteEncryptSecret(plain);
    assert.equal(remoteDecryptSecret(fresh), plain);
    assert.equal(remoteIsLegacySecret(fresh), false);
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_USER_DATA;
    else process.env.ELECTRON_USER_DATA = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
