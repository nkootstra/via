import { describe, expect, it } from "@effect/vitest";
import type { CatalogModel } from "@via/codex-upstream";
import type { FallbackRule } from "@via/fallbacks";
import { Schema } from "effect";
import { candidatesFor } from "./fallback.ts";

const catalog: ReadonlyArray<CatalogModel> = [
  { model: "gpt-5.6-sol", efforts: ["low", "high", "max"] },
  { model: "gpt-5.5", efforts: ["low", "high"] },
  { model: "gpt-5.1-codex-max", efforts: ["high"] },
];

const sol: FallbackRule = { model: "gpt-5.6-sol", fallbacks: ["gpt-5.5", "opencode-go/kimi-k3"] };

describe("candidatesFor", () => {
  it("is the rule's models, in order, for a model with a rule", () => {
    expect(candidatesFor([sol], "gpt-5.6-sol", catalog)).toEqual([
      "gpt-5.5",
      "opencode-go/kimi-k3",
    ]);
  });

  it("is nothing for a model without a rule", () => {
    expect(candidatesFor([sol], "gpt-5.5", catalog)).toEqual([]);
    expect(candidatesFor([sol], "opencode-go/gpt-5.6-sol-high", catalog)).toEqual([]);
  });

  it("covers a model's efforts, keeping the effort where a fallback has it", () => {
    expect(candidatesFor([sol], "gpt-5.6-sol-high", catalog)).toEqual([
      "gpt-5.5-high",
      "opencode-go/kimi-k3",
    ]);
    expect(candidatesFor([sol], "gpt-5.6-sol-max", catalog)).toEqual([
      "gpt-5.5",
      "opencode-go/kimi-k3",
    ]);
  });

  it("prefers a rule for the exact id, used as written", () => {
    const high: FallbackRule = { model: "gpt-5.6-sol-high", fallbacks: ["gpt-5.5-low"] };

    expect(candidatesFor([sol, high], "gpt-5.6-sol-high", catalog)).toEqual(["gpt-5.5-low"]);
  });

  it("keeps an effort a fallback already names", () => {
    const rule: FallbackRule = { model: "gpt-5.6-sol", fallbacks: ["gpt-5.5-low"] };

    expect(candidatesFor([rule], "gpt-5.6-sol-high", catalog)).toEqual(["gpt-5.5-low"]);
  });

  it("doesn't read a model named like an effort as one", () => {
    const rule: FallbackRule = { model: "gpt-5.1-codex", fallbacks: ["gpt-5.5"] };

    expect(candidatesFor([rule], "gpt-5.1-codex-max", catalog)).toEqual([]);
  });

  it("leaves out the model asked for, when an effort makes a fallback become it", () => {
    const rule: FallbackRule = { model: "gpt-5.6-sol", fallbacks: ["gpt-5.5", "gpt-5.6-sol-high"] };

    expect(candidatesFor([rule], "gpt-5.6-sol-high", catalog)).toEqual(["gpt-5.5-high"]);
  });

  const Id = Schema.Literals([
    "gpt-5.6-sol",
    "gpt-5.6-sol-high",
    "gpt-5.6-sol-low",
    "gpt-5.5",
    "gpt-5.5-high",
    "gpt-5.1-codex-max",
    "opencode-go/kimi-k3",
    "openrouter/a/b-high",
  ]);

  const Rule = Schema.Struct({
    model: Id,
    fallbacks: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  });

  /** `rules` as the store keeps them: valid, at most one per model. */
  const valid = (rules: ReadonlyArray<typeof Rule.Type>) =>
    rules.flatMap((rule, index) => {
      const fallbacks = [...new Set(rule.fallbacks)].filter((id) => id !== rule.model);
      const first = rules.findIndex((other) => other.model === rule.model) === index;

      return fallbacks.length > 0 && first ? [{ model: rule.model, fallbacks }] : [];
    });

  it.prop(
    "never offers the model asked for or one model twice, nor more than a rule lists",
    { rules: Schema.Array(Rule), requested: Id },
    ({ rules, requested }) => {
      const candidates = candidatesFor(valid(rules), requested, catalog);

      return (
        !candidates.includes(requested) &&
        new Set(candidates).size === candidates.length &&
        candidates.length <= 3
      );
    },
  );

  it.prop(
    "offers only a rule's models, or one with the effort asked for that its model lists",
    { rules: Schema.Array(Rule), requested: Id },
    ({ rules, requested }) => {
      const kept = valid(rules);
      const targets: ReadonlyArray<string> = kept.flatMap((rule) => rule.fallbacks);

      return candidatesFor(kept, requested, catalog).every(
        (candidate) =>
          targets.includes(candidate) ||
          catalog.some(
            ({ model, efforts }) =>
              targets.includes(model) &&
              efforts.some(
                (effort) => candidate === `${model}-${effort}` && requested.endsWith(`-${effort}`),
              ),
          ),
      );
    },
  );

  it.prop(
    "uses an exact rule as written",
    { rules: Schema.Array(Rule), requested: Id },
    ({ rules, requested }) => {
      const kept = valid(rules);
      const exact = kept.find((rule) => rule.model === requested);

      return (
        exact === undefined ||
        candidatesFor(kept, requested, catalog).join() === exact.fallbacks.join()
      );
    },
  );
});
