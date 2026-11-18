import crypto from "node:crypto";

/**
 * AES-256-GCM encryption for router credentials at rest.
 * Key is derived from APP_SECRET env var. Never expose decrypted values to the client.
 */
const RAW_SECRET = process.env.APP_SECRET || "mikrotik-cloud-manager-fallback-secret";

const KEY = crypto.createHash("sha256").update(RAW_SECRET).digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  try {
    const [ivB64, tagB64, dataB64] = payload.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("فك تشفير بيانات السيرفر فشل — تأكد من APP_SECRET");
  }
}

/** scrypt password hashing (no plaintext storage) */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
