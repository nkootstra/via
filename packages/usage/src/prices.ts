import { resolveAlias } from "@via/codex-upstream";
import type { ModelPrice } from "@via/config";
import { Option } from "effect";
import { priceSnapshot } from "./price-snapshot.ts";
import type { ModelUsage } from "./usage-history.ts";

/** A model's price, if via knows one. */
export type PriceBook = (model: string) => Option.Option<ModelPrice>;

/**
 * The names a model's price may be listed under, most specific first: as asked
 * for, without its provider, and without a reasoning effort suffix.
 */
const namesOf = (model: string) => {
  const bare = model.split("/").at(-1) ?? model;

  return [...new Set([model, bare, resolveAlias(bare).model].map((name) => name.toLowerCase()))];
};

/** What a model on your own hardware costs: its tokens aren't billed by anyone. */
const FREE: ModelPrice = { input: 0, output: 0 };

/**
 * Prices from config.yaml's `prices`, which win, else nothing for a model of a
 * `local` provider, else from the snapshot of LiteLLM's table via ships with.
 * Names are matched without case.
 */
export const priceBook = (
  overrides: Readonly<Record<string, ModelPrice>>,
  {
    snapshot = priceSnapshot,
    local = [],
  }: {
    readonly snapshot?: ReadonlyMap<string, ModelPrice>;
    readonly local?: ReadonlyArray<string>;
  } = {},
): PriceBook => {
  const configured = new Map(
    Object.entries(overrides).map(([model, price]) => [model.toLowerCase(), price]),
  );

  return (model) => {
    const names = namesOf(model);

    return Option.firstSomeOf(
      [
        ...names.map((name) => configured.get(name)),
        local.includes(model.split("/")[0] ?? "") ? FREE : undefined,
        ...names.map((name) => snapshot.get(name)),
      ].map(Option.fromUndefinedOr),
    );
  };
};

/**
 * What usage cost: what upstreams billed, what the rest would have cost at API
 * prices, and the models whose tokens couldn't be priced, which count as
 * unknown rather than free.
 */
export interface Cost {
  readonly apiEquivalentUsd: number;
  readonly billedUsd: number;
  readonly unpriced: ReadonlyArray<string>;
}

const PER_MILLION = 1_000_000;

export const costOf = (models: ReadonlyArray<ModelUsage>, prices: PriceBook): Cost => {
  let apiEquivalentUsd = 0;
  let billedUsd = 0;
  const unpriced = new Set<string>();

  for (const { model, billedUsd: billed, unbilled } of models) {
    billedUsd += billed;
    const tokens = unbilled.inputTokens + unbilled.outputTokens;

    if (tokens === 0) continue;

    const price = prices(model);

    if (Option.isNone(price)) {
      unpriced.add(model);
      continue;
    }

    const { input, cachedInput = input, output } = price.value;
    // Cached tokens are part of the input; an upstream reporting more is not taken at its word.
    const cached = Math.min(unbilled.cachedTokens, unbilled.inputTokens);
    const uncached = unbilled.inputTokens - cached;

    apiEquivalentUsd +=
      (uncached * input + cached * cachedInput + unbilled.outputTokens * output) / PER_MILLION;
  }

  return { apiEquivalentUsd, billedUsd, unpriced: [...unpriced] };
};
