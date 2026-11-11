/**
 * 远程文件源凭据加密。
 *
 * 密钥来源（v2，2026-11 起）：
 * - 独立密钥文件 `<dataDir>/.remote_secret_key`（32 字节随机，0600），与插件平台同一套模式；
 * - **不再用 JWT_SECRET 派生**。原因：JWT_SECRET 没配时会回退到源码里写死的常量（谁拿到代码
 *   谁就能解）；备份包带 `.jwt_secret`，等于把解凭据的钥匙一起送出去；轮换 JWT_SECRET 或换机
 *   恢复会让所有远程源密码静默解成空串，表现为莫名其妙的「认证失败」。
 * - 密钥文件不写进备份包：换机恢复后凭据解不开是**预期行为**，此时 UI 明确提示
 *   「凭据已失效，请重新输入密码」，而不是静默当匿名登录（见 credentialState）。
 *
 * 兼容：历史密文是 `v1:`（scrypt(JWT_SECRET) 派生），读取时仍能解密，并被上层自动升级为 v2。
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

/** v1（历史）用盐；v2 直接用密钥文件，不再派生 */
const LEGACY_SALT = "baseforge-remote-files-v1";

function dataDir(): string {
  return process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
}

function keyPath(): string {
  return path.join(dataDir(), ".remote_secret_key");
}

let cachedKey: Buffer | null = null;

/** 读取（必要时创建）独立密钥文件；并发安全用 wx 标志。 */
function remoteKey(): Buffer {
  if (cachedKey) return cachedKey;
  const target = keyPath();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      // 并发下另一个调用已创建：继续读取即可
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  const key = fs.readFileSync(target);
  if (key.length !== 32) throw new Error("远程凭据密钥长度无效（.remote_secret_key 应为 32 字节）");
  cachedKey = key;
  return key;
}

/** 仅用于解密历史 v1 密文；新密文不再走这里。 */
function legacyKey(): Buffer {
  const secret = process.env.JWT_SECRET || "";
  const source = secret.length >= 16 ? secret : "baseforge-remote-files-development-key";
  return crypto.scryptSync(source, LEGACY_SALT, 32);
}

function seal(key: Buffer, value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

function open(key: Buffer, ivB64: string, tagB64: string, payloadB64: string): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payloadB64, "base64")), decipher.final()]).toString("utf8");
}

export function encryptSecret(value: string): string {
  if (!value) return "";
  return `v2:${seal(remoteKey(), value)}`;
}

/**
 * 解密：v2 → 独立密钥；v1 → 历史 JWT 派生密钥（仅兼容存量）。
 * 解不开一律返回空串，调用方用 hasUnreadableSecret 区分「本来没设」与「解不开」。
 */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  try {
    if (stored.startsWith("v2:")) {
      const [, iv, tag, payload] = stored.split(":");
      return open(remoteKey(), iv, tag, payload);
    }
    const [version, iv, tag, payload] = stored.split(":");
    if (version !== "v1") return "";
    return open(legacyKey(), iv, tag, payload);
  } catch (error) {
    console.warn("[remote-files] decrypt secret failed:", error instanceof Error ? error.message : error);
    return "";
  }
}

/** 是否为需要重新输入的历史密文（v1）：上层可静默升级为 v2。 */
export function isLegacySecret(stored: string): boolean {
  return Boolean(stored) && stored.startsWith("v1:");
}

/** 密文存在但解不开（换机、换密钥、备份跨机恢复）：UI 需要提示重新输入密码。 */
export function hasUnreadableSecret(stored: string): boolean {
  if (!stored) return false;
  return decryptSecret(stored) === "";
}

/** 升级 v1 → v2（幂等；失败返回原值）。 */
export function upgradeSecret(stored: string): string {
  if (!isLegacySecret(stored)) return stored;
  const plain = decryptSecret(stored);
  if (!plain) return stored;
  try {
    return encryptSecret(plain);
  } catch {
    return stored;
  }
}
