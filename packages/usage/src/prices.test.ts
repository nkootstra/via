import { describe, expect, it } from "@effect/vitest";
import type { ModelPrice } from "@via/config";
import { Option, Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { costOf, priceBook } from "./prices.ts";
import type { ModelUsage } from "./usage-history.ts";

const snapshot = new Map<string, ModelPrice>([
  ["gpt-6-astra", { input: 2, cachedInput: 0.5, output: 10 }],
  ["kimi-k3", { input: 3, cachedInput: 0.3, output: 15 }],
  ["minimax-m3", { input: 0.3, output: 1.2 }],
  ["opencode-go/deepseek-v4.1-flash", { input: 0.15, cachedInput: 0.003, output: 0.6 }],
  ["deepseek-v4.1-flash", { input: 0.3, output: 1.2 }],
]);

const book = priceBook({ "opencode-go/kimi-k3": { input: 1, output: 4 } }, snapshot);

describe("priceBook", () => {
  it("finds a model by its name", () => {
    expect(book("gpt-6-astra")).toEqual(Option.some({ input: 2, cachedInput: 0.5, output: 10 }));
  });

  it("finds a model asked for with a reasoning effort by the model's own price", () => {
    expect(book("gpt-6-astra-xhigh")).toEqual(book("gpt-6-astra"));
  });

  it("finds a provider's model by its name without the provider", () => {
    expect(book("openrouter/minimax-m3")).toEqual(Option.some({ input: 0.3, output: 1.2 }));
  });

  it("prefers the price the model's own provider charges over one for the bare name", () => {
    expect(book("opencode-go/deepseek-v4.1-flash")).toEqual(
      Option.some({ input: 0.15, cachedInput: 0.003, output: 0.6 }),
    );
    expect(book("openrouter/deepseek-v4.1-flash")).toEqual(
      Option.some({ input: 0.3, output: 1.2 }),
    );
  });

  it("ignores case, as model names differ in it from provider to provider", () => {
    expect(book("opencode-go/MiniMax-M3")).toEqual(Option.some({ input: 0.3, output: 1.2 }));
  });

  it("prefers a price from config.yaml", () => {
    expect(book("opencode-go/kimi-k3")).toEqual(Option.some({ input: 1, output: 4 }));
    expect(book("openrouter/kimi-k3")).toEqual(
      Option.some({ input: 3, cachedInput: 0.3, output: 15 }),
    );
  });

  it("knows no price for a model neither lists", () => {
    expect(book("local/llama")).toEqual(Option.none());
  });
});

const usage = (model: string, overrides: Partial<ModelUsage> = {}): ModelUsage => ({
  model,
  billedUsd: 0,
  billedRequests: 0,
  unbilled: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
  ...overrides,
});

describe("costOf", () => {
  it("prices uncached input, cached input and output each at their own rate", () => {
    const cost = costOf(
      [
        usage("gpt-6-astra", {
          unbilled: { inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 100_000 },
        }),
      ],
      book,
    );

    // 600k uncached at $2, 400k cached at $0.50, 100k out at $10 per million.
    expect(cost).toEqual({ apiEquivalentUsd: 1.2 + 0.2 + 1, billedUsd: 0, unpriced: [] });
  });

  it("prices cached input as input when the model has no cached price", () => {
    const cost = costOf(
      [
        usage("minimax-m3", {
          unbilled: { inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0 },
        }),
      ],
      book,
    );

    expect(cost.apiEquivalentUsd).toBeCloseTo(0.3);
  });

  it("keeps what an upstream billed apart from what via priced", () => {
    const cost = costOf([usage("local/llama", { billedUsd: 0.42, billedRequests: 3 })], book);
    expect(cost).toEqual({ apiEquivalentUsd: 0, billedUsd: 0.42, unpriced: [] });
  });

  it("names a model with tokens to price but no price, rather than pricing it at $0", () => {
    const cost = costOf(
      [usage("local/llama", { unbilled: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 } })],
      book,
    );

    expect(cost).toEqual({ apiEquivalentUsd: 0, billedUsd: 0, unpriced: ["local/llama"] });
  });

  const Tokens = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 }));

  const Usage = Schema.Struct({
    model: Schema.Literals(["gpt-6-astra", "gpt-6-astra-high", "minimax-m3", "local/llama"]),
    input: Tokens,
    cachedShare: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    output: Tokens,
  });

  it.prop(
    "costs add up: a list costs what its parts cost apart, and never less than nothing",
    { usages: Arbitrary.array(Arbitrary.schema(Usage), { maxLength: 8 }) },
    ({ usages }) => {
      const models = usages.map((u) =>
        usage(u.model, {
          unbilled: {
            inputTokens: u.input,
            cachedTokens: Math.floor(u.input * u.cachedShare),
            outputTokens: u.output,
          },
        }),
      );

      const whole = costOf(models, book).apiEquivalentUsd;
      const parts = models.map((m) => costOf([m], book).apiEquivalentUsd);

      expect(whole).toBeGreaterThanOrEqual(0);
      expect(whole).toBeCloseTo(
        parts.reduce((a, b) => a + b, 0),
        6,
      );
    },
  );
});
