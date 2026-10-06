import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { builtinModules } from "node:module";
import manifest from "../../package.json" with { type: "json" };

const packagesDir = Bun.fileURLToPath(new URL("../../../", import.meta.url));

/**
 * A browser bundle of `@via/server/admin-api`: whether it built, the Node builtins it
 * imports, and the files of via's own packages it takes in.
 */
const browserBundle = Effect.promise(async () => {
  const builtins: Array<string> = [];
  const viaFiles: Array<string> = [];

  const result = await Bun.build({
    entrypoints: [
      Bun.fileURLToPath(new URL(`../../${manifest.exports["./admin-api"]}`, import.meta.url)),
    ],
    target: "browser",
    plugins: [
      {
        name: "record-imports",
        setup: (build) => {
          build.onResolve({ filter: /.*/ }, ({ path }) => {
            if (path.startsWith("node:") || builtinModules.includes(path)) builtins.push(path);

            return undefined;
          });
          build.onLoad({ filter: /.*/ }, ({ path }) => {
            if (path.startsWith(packagesDir)) viaFiles.push(path.slice(packagesDir.length));

            return undefined;
          });
        },
      },
    ],
  });

  return { success: result.success, builtins, viaFiles };
});

describe("admin API contract", () => {
  it.effect("bundles for the browser from effect and via's import-light modules only", () =>
    Effect.gen(function* () {
      const { success, builtins, viaFiles } = yield* browserBundle;
      expect(success).toBe(true);
      expect(builtins).toEqual([]);
      expect(viaFiles.toSorted()).toEqual([
        "codex-auth/src/errors.ts",
        "fallbacks/src/rule.ts",
        "keys/src/errors.ts",
        "providers/src/errors.ts",
        "providers/src/schemas.ts",
        "server/src/admin/api.ts",
        "usage/src/entry.ts",
      ]);
    }),
  );
});
