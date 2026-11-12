// Encryption of secrets at rest (users' AI keys, Shopify tokens). AES-256-GCM with
// key = sha256(APP_ENCRYPTION_KEY). Format: `v1:<iv b64>:<tag b64>:<ciphertext b64>`.
// Changing APP_ENCRYPTION_KEY orphans stored secrets (users must re-enter them).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DEV_ENCRYPTION_KEY, env } from "@/src/lib/env";

function key(): Buffer {
  if (env.NODE_ENV === "production" && env.APP_ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) {
    throw new Error("APP_ENCRYPTION_KEY must be set to a strong random value in production");
  }
  return createHash("sha256").update(env.APP_ENCRYPTION_KEY).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Throws if the value is malformed or was encrypted with a different key. */
export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split(":");
  if (v !== "v1" || !iv || !tag || ct == null) throw new Error("Unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
