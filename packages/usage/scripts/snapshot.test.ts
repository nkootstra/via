import { describe, expect, it } from "@effect/vitest";
import { pricesOf, snapshotSource } from "./snapshot.ts";

const litellm = {
  "gpt-6": {
    mode: "chat",
    litellm_provider: "openai",
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.0000002,
  },
  "claude-6": {
    mode: "chat",
    litellm_provider: "anthropic",
    input_cost_per_token: 0.000009,
    output_cost_per_token: 0.00009,
  },
  "claude-mini-6": {
    mode: "chat",
    litellm_provider: "anthropic",
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000005,
    cache_creation_input_token_cost: 0.00000125,
  },
  "dall-e-9": { mode: "image_generation", litellm_provider: "openai" },
};

const modelsDev = {
  anthropic: {
    models: { "Claude-6": { cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 } } },
  },
  "opencode-go": { models: { "kimi-k3": { cost: { input: 0.6, output: 2.5 } } } },
};

describe("pricesOf", () => {
  it("takes a maker's price from models.dev before LiteLLM, and LiteLLM's for the rest, cache writes included", () => {
    expect(pricesOf(litellm, modelsDev)).toEqual([
      ["claude-6", { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }],
      ["claude-mini-6", { input: 1, cacheWrite: 1.25, output: 5 }],
      ["gpt-6", { input: 2, cachedInput: 0.2, output: 10 }],
      ["opencode-go/kimi-k3", { input: 0.6, output: 2.5 }],
    ]);
  });
});

describe("snapshotSource", () => {
  it("writes a cache-write price where there is one", () => {
    expect(
      snapshotSource([["claude-6", { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }]]),
    ).toContain('  ["claude-6", { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }],');
  });
});
