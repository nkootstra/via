import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore } from "./index.ts";

let dir: string;
let store: KeyStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "via-keys-"));
  store = new KeyStore(join(dir, "keys.json"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("KeyStore", () => {
  it("creates a via_ key that verifies to its name", async () => {
    const created = await store.create("laptop");
    expect(created.key).toMatch(/^via_[A-Za-z0-9]{32}$/);
    expect(await store.verify(created.key)).toEqual({ id: created.id, name: "laptop" });
  });

  it("does not store the plaintext key", async () => {
    const { key } = await store.create("laptop");
    expect(await readFile(join(dir, "keys.json"), "utf8")).not.toContain(key);
  });

  it("rejects unknown keys", async () => {
    await store.create("laptop");
    expect(await store.verify("via_notarealkeynotarealkeynotareal")).toBeNull();
  });

  it("lists keys without exposing them", async () => {
    const { id } = await store.create("laptop");
    expect(await store.list()).toEqual([{ id, name: "laptop", createdAt: expect.any(String) }]);
  });

  it("revoked keys stop verifying", async () => {
    const { id, key } = await store.create("laptop");
    expect(await store.revoke(id)).toBe(true);
    expect(await store.verify(key)).toBeNull();
  });

  it("revokes by name too, and reports unknown targets", async () => {
    await store.create("laptop");
    expect(await store.revoke("laptop")).toBe(true);
    expect(await store.revoke("laptop")).toBe(false);
  });

  it("refuses duplicate names", async () => {
    await store.create("laptop");
    await expect(store.create("laptop")).rejects.toThrow(/already exists/);
  });
});
