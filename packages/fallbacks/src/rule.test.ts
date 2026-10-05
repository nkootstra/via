import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FallbackRule, FallbackRules } from "./rule.ts";

const decode = Schema.decodeUnknownEffect(FallbackRule);

/** Why decoding `input`, as a client might send it, as a rule fails. */
const problem = (input: { readonly model: string; readonly fallbacks: ReadonlyArray<string> }) =>
  decode(input).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

describe("FallbackRule", () => {
  it.effect("takes a model and the models it falls back to, ids with a provider included", () =>
    Effect.gen(function* () {
      const rule = { model: "gpt-5.6-sol", fallbacks: ["opencode-go/kimi-k3", "gpt-5.5"] };

      expect(yield* decode(rule)).toEqual(rule);
    }),
  );

  it.effect("needs at least one model to fall back to", () =>
    Effect.gen(function* () {
      expect(yield* problem({ model: "gpt-5.5", fallbacks: [] })).toContain(
        "Add at least one model to fall back to",
      );
    }),
  );

  it.effect("takes at most three models to fall back to", () =>
    Effect.gen(function* () {
      expect(yield* problem({ model: "a", fallbacks: ["b", "c", "d", "e"] })).toContain(
        "A model can fall back to at most 3 others",
      );
    }),
  );

  it.effect("refuses a model that falls back to itself", () =>
    Effect.gen(function* () {
      expect(yield* problem({ model: "gpt-5.5", fallbacks: ["kimi", "gpt-5.5"] })).toContain(
        "gpt-5.5 can't fall back to itself",
      );
    }),
  );

  it.effect("refuses a model listed twice", () =>
    Effect.gen(function* () {
      expect(yield* problem({ model: "gpt-5.5", fallbacks: ["kimi", "kimi"] })).toContain(
        "kimi is in the list twice",
      );
    }),
  );

  it.effect("refuses a model id with spaces or control characters, which none has", () =>
    Effect.gen(function* () {
      for (const id of [" gpt-5", "gpt 5", "gpt-5\r\nx-evil: 1"]) {
        expect(yield* problem({ model: "a", fallbacks: [id] })).toContain(
          "A model id has no spaces or control characters",
        );
      }
    }),
  );

  it.effect("refuses an empty or overlong model id", () =>
    Effect.gen(function* () {
      expect(yield* problem({ model: "", fallbacks: ["kimi"] })).toContain("Name a model");
      expect(yield* problem({ model: "a", fallbacks: ["x".repeat(201)] })).toContain(
        "A model id is at most 200 characters",
      );
    }),
  );
});

describe("FallbackRules", () => {
  it.effect("refuses two rules for the same model", () =>
    Effect.gen(function* () {
      const rules = [
        { model: "a", fallbacks: ["b"] },
        { model: "a", fallbacks: ["c"] },
      ];

      const error = yield* Schema.decodeUnknownEffect(FallbackRules)(rules).pipe(Effect.flip);

      expect(error.message).toContain("a has two rules");
    }),
  );
});
