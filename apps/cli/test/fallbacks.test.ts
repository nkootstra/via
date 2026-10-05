import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { runVia, tempHome } from "./helpers.ts";

layer(BunFileSystem.layer)("via fallbacks", (it) => {
  it.effect("list explains how to set fallbacks when there are none", () =>
    Effect.gen(function* () {
      const list = yield* runVia(yield* tempHome, ["fallbacks", "list"]);

      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("via fallbacks set <model> <fallback...>");
    }),
  );

  it.effect("set keeps a model's fallbacks in order, and list shows them", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;

      const set = yield* runVia(home, [
        "fallbacks",
        "set",
        "gpt-5.6-sol",
        "opencode-go/kimi-k3",
        "gpt-5.5",
      ]);

      expect(set.exitCode).toBe(0);
      expect(set.stdout).toContain("gpt-5.6-sol falls back to opencode-go/kimi-k3, then gpt-5.5");

      yield* runVia(home, ["fallbacks", "set", "gpt-5.5", "opencode-go/glm-5.2"]);

      expect((yield* runVia(home, ["fallbacks", "list"])).stdout.trimEnd().split("\n")).toEqual([
        "gpt-5.6-sol  -> opencode-go/kimi-k3 -> gpt-5.5",
        "gpt-5.5      -> opencode-go/glm-5.2",
      ]);
    }),
  );

  it.effect("set refuses a rule via can't keep, saying why", () =>
    Effect.gen(function* () {
      const result = yield* runVia(yield* tempHome, ["fallbacks", "set", "gpt-5.5", "gpt-5.5"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe("error: gpt-5.5 can't fall back to itself");
    }),
  );

  it.effect("remove forgets a model's fallbacks, and fails on a model without any", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* runVia(home, ["fallbacks", "set", "gpt-5.5", "opencode-go/glm-5.2"]);

      expect((yield* runVia(home, ["fallbacks", "remove", "gpt-5.5"])).exitCode).toBe(0);
      expect((yield* runVia(home, ["fallbacks", "list"])).stdout).not.toContain("glm");

      const again = yield* runVia(home, ["fallbacks", "remove", "gpt-5.5"]);
      expect(again.exitCode).toBe(1);
      expect(again.stderr.trim()).toBe("error: No fallbacks are set for gpt-5.5");
    }),
  );
});
