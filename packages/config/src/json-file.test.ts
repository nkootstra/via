import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "via-json-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("json files", () => {
  it("round-trips data, creating parent directories", async () => {
    const file = join(dir, "nested", "data.json");
    await writeJsonFile(file, { hello: "world" });
    expect(await readJsonFile<unknown>(file, null)).toEqual({ hello: "world" });
  });

  it("returns the fallback when the file does not exist", async () => {
    expect(await readJsonFile(join(dir, "missing.json"), [])).toEqual([]);
  });

  it("writes files readable only by the owner", async () => {
    const file = join(dir, "secret.json");
    await writeJsonFile(file, { token: "x" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary files behind", async () => {
    await writeJsonFile(join(dir, "a.json"), 1);
    await writeJsonFile(join(dir, "a.json"), 2);
    expect(await readdir(dir)).toEqual(["a.json"]);
  });
});
