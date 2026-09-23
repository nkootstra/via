import { timingSafeEqual } from "node:crypto";
import { readJsonFile, writeJsonFile } from "@via/config";

type StoredKey = { id: string; name: string; hash: string; createdAt: string };
export type KeyInfo = { id: string; name: string; createdAt: string };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomString(length: number): string {
  // 248 is the largest multiple of 62 below 256; rejecting above it avoids modulo bias.
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 248 && out.length < length) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

function hash(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

export class KeyStore {
  constructor(private readonly path: string) {}

  private read(): Promise<StoredKey[]> {
    return readJsonFile<StoredKey[]>(this.path, []);
  }

  async create(name: string): Promise<{ id: string; name: string; key: string }> {
    const keys = await this.read();
    if (keys.some((k) => k.name === name)) throw new Error(`A key named "${name}" already exists`);
    const key = `via_${randomString(32)}`;
    const id = randomString(8).toLowerCase();
    keys.push({ id, name, hash: hash(key), createdAt: new Date().toISOString() });
    await writeJsonFile(this.path, keys);
    return { id, name, key };
  }

  async list(): Promise<KeyInfo[]> {
    return (await this.read()).map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  async revoke(idOrName: string): Promise<boolean> {
    const keys = await this.read();
    const remaining = keys.filter((k) => k.id !== idOrName && k.name !== idOrName);
    if (remaining.length === keys.length) return false;
    await writeJsonFile(this.path, remaining);
    return true;
  }

  async verify(key: string): Promise<{ id: string; name: string } | null> {
    const candidate = Buffer.from(hash(key), "hex");
    for (const k of await this.read()) {
      if (timingSafeEqual(candidate, Buffer.from(k.hash, "hex"))) return { id: k.id, name: k.name };
    }
    return null;
  }
}
