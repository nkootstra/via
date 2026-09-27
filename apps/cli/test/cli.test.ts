import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { version } from "../src/version.ts";
import { runVia, tempHome } from "./helpers.ts";

layer(BunFileSystem.layer)("via", (it) => {
  it.effect("--version prints the version", () =>
    Effect.gen(function* () {
      const result = yield* runVia(yield* tempHome, ["--version"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`via v${version}\n`);
    }),
  );

  it.effect("a usage error prints the command's help and the error once, and exits 1", () =>
    Effect.gen(function* () {
      const result = yield* runVia(yield* tempHome, ["keys", "create"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("via keys create [flags]");
      expect(result.stderr).toContain("Missing required flag: --name");
      expect(result.stderr).not.toMatch(/^error: /m);
    }),
  );
});
