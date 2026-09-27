import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { createKey, runVia, tempHome } from "./helpers.ts";

const KeyFile = Schema.fromJsonString(Schema.Array(Schema.JsonObject));

/** Sets when key `name` in `home` was last used, as a running `via serve` records it. */
const markUsed = (home: string, name: string, at: Date) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${home}/keys.json`;
    const keys = yield* Schema.decodeEffect(KeyFile)(yield* fs.readFileString(file));
    const used = keys.map((k) => (k["name"] === name ? { ...k, lastUsedAt: at.toISOString() } : k));
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(KeyFile)(used));
  });

layer(BunFileSystem.layer)("via keys", (it) => {
  it.effect("create prints a new via_ key once", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const result = yield* runVia(home, ["keys", "create", "--name", "laptop"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/via_[A-Za-z0-9]{32}/);
    }),
  );

  it.effect("list explains how to create a key when there is none", () =>
    Effect.gen(function* () {
      const list = yield* runVia(yield* tempHome, ["keys", "list"]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("via keys create --name <name>");
    }),
  );

  it.effect("list shows key names but never the key itself", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const key = yield* createKey(home, "laptop");
      const list = yield* runVia(home, ["keys", "list"]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("laptop");
      expect(list.stdout).not.toContain(key);
    }),
  );

  it.effect("list shows when each key was last used, in aligned columns", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* createKey(home, "laptop");
      yield* createKey(home, "ci-runner");
      yield* markUsed(home, "laptop", new Date(Date.now() - 3 * 60_000 - 5_000));

      const lines = (yield* runVia(home, ["keys", "list"])).stdout.trimEnd().split("\n");
      expect(lines).toEqual([
        expect.stringMatching(/ laptop +created \d{4}-\d\d-\d\d \d\d:\d\d {2}last used 3 min ago$/),
        expect.stringMatching(/ ci-runner +created \d{4}-\d\d-\d\d \d\d:\d\d {2}never used$/),
      ]);
      expect(new Set(lines.map((line) => line.indexOf("created"))).size).toBe(1);
    }),
  );

  it.effect("revoke removes the key from the list", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* runVia(home, ["keys", "create", "--name", "laptop"]);
      const revoke = yield* runVia(home, ["keys", "revoke", "laptop"]);
      expect(revoke.exitCode).toBe(0);
      expect((yield* runVia(home, ["keys", "list"])).stdout).not.toContain("laptop");
    }),
  );

  it.effect("revoking an unknown key fails", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const result = yield* runVia(home, ["keys", "revoke", "nope"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('No key with id or name "nope"');
    }),
  );

  it.effect("rename gives a key a new name, and the key keeps its secret", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      yield* createKey(home, "laptop");
      const before = yield* fs.readFileString(`${home}/keys.json`);

      const rename = yield* runVia(home, ["keys", "rename", "laptop", "desktop"]);
      expect(rename.exitCode).toBe(0);
      expect(rename.stdout).toContain('Renamed "laptop" to "desktop".');
      // Only the name changed: the id, the key's hash and when it was created are as they were.
      const after = yield* fs.readFileString(`${home}/keys.json`);
      expect(after).toBe(before.replace('"laptop"', '"desktop"'));
    }),
  );

  it.effect("renaming an unknown key fails", () =>
    Effect.gen(function* () {
      const result = yield* runVia(yield* tempHome, ["keys", "rename", "nope", "desktop"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('No key with id or name "nope"');
    }),
  );

  it.effect("renaming a key to another key's name fails", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* createKey(home, "laptop");
      yield* createKey(home, "desktop");
      const result = yield* runVia(home, ["keys", "rename", "laptop", "desktop"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('A key named "desktop" already exists');
    }),
  );

  it.effect("creating a duplicate name fails", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* runVia(home, ["keys", "create", "--name", "laptop"]);
      const result = yield* runVia(home, ["keys", "create", "--name", "laptop"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('A key named "laptop" already exists');
    }),
  );
});
