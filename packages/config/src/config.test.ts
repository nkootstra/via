import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "via-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns defaults when the file does not exist", async () => {
    expect(await loadConfig(join(dir, "config.yaml"))).toEqual({
      host: "127.0.0.1",
      port: 8317,
      codex: { cloak: true },
    });
  });

  test("merges values from YAML over defaults", async () => {
    const file = join(dir, "config.yaml");
    await writeFile(file, "port: 9000\ncodex:\n  cloak: false\n");
    expect(await loadConfig(file)).toEqual({
      host: "127.0.0.1",
      port: 9000,
      codex: { cloak: false },
    });
  });

  test("rejects an invalid port with a readable error", async () => {
    const file = join(dir, "config.yaml");
    await writeFile(file, "port: nope\n");
    expect(loadConfig(file)).rejects.toThrow(/port/);
  });
});
