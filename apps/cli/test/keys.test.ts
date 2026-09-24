import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { runVia, tempHome } from "./helpers.ts";

layer(BunFileSystem.layer)("via keys", (it) => {
  it.effect("create prints a new via_ key once", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const result = yield* runVia(home, ["keys", "create", "--name", "laptop"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/via_[A-Za-z0-9]{32}/);
    }),
  );

  it.effect("list shows key names but never the key itself", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const created = yield* runVia(home, ["keys", "create", "--name", "laptop"]);
      const key = created.stdout.match(/via_[A-Za-z0-9]{32}/)?.[0];
      const list = yield* runVia(home, ["keys", "list"]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("laptop");
      expect(list.stdout).not.toContain(key);
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
