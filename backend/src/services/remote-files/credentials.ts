/**
 * 远程文件源凭据加密 —— 与 backup-webdav / calendar-export 同一模式：
 * scrypt(JWT_SECRET, "nowen-remote-files-v1") → aes-256-gcm，格式 v1:iv:tag:payload(base64)。
 */
import crypto from "crypto";

const SALT = "nowen-remote-files-v1";

function keySource(): string {
  const secret = process.env.JWT_SECRET || "";
  if (secret.length >= 16) return secret;
  return "nowen-note-remote-files-development-key";
}

function encryptionKey(): Buffer {
  return crypto.scryptSync(keySource(), SALT, 32);
}

export function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  try {
    const [version, ivB64, tagB64, payloadB64] = stored.split(":");
    if (version !== "v1") return "";
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payloadB64, "base64")), decipher.final()]).toString("utf8");
  } catch (error) {
    console.warn("[remote-files] decrypt secret failed:", error instanceof Error ? error.message : error);
    return "";
  }
}
