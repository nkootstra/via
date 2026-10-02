/**
 * Builds `src/price-snapshot.ts`, in USD per million tokens, from two
 * MIT-licensed tables:
 *
 * - models.dev, for what OpenCode Go charges for each of its models, under
 *   `opencode-go/<model>` as via names them, and for what each model's maker
 *   charges, by bare model name;
 * - LiteLLM, for the chat and Responses API models of those makers that
 *   models.dev doesn't price, by bare model name.
 */
import type { ModelPrice } from "@via/config";
import { Schema } from "effect";

/** LiteLLM's providers in order of precedence: a model two of them list takes the first one's price. */
const PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "mistral",
  "deepseek",
  "moonshot",
  "zai",
  "minimax",
  "dashscope",
];

/** models.dev's providers whose models via routes under the same `<provider>/` prefix. */
const PREFIXED = ["opencode-go"];

/**
 * models.dev's model makers, in the same precedence as `PROVIDERS`. Where the
 * two tables differ on a maker's own price, models.dev's has been the current one.
 */
const MAKERS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "mistral",
  "deepseek",
  "moonshotai",
  "zai",
  "minimax",
  "alibaba",
];

const LiteLlmEntry = Schema.Struct({
  // Codex models are listed under the Responses API rather than chat.
  mode: Schema.Literals(["chat", "responses"]),
  litellm_provider: Schema.Literals(PROVIDERS),
  input_cost_per_token: Schema.Finite,
  output_cost_per_token: Schema.Finite,
  cache_read_input_token_cost: Schema.optionalKey(Schema.Finite),
});

const isLiteLlmEntry = Schema.is(LiteLlmEntry);

export const LiteLlm = Schema.Record(Schema.String, Schema.Json);

/** A models.dev model's base price, already per million tokens; longer-context tiers are left out. */
const ModelsDevModel = Schema.Struct({
  cost: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cache_read: Schema.optionalKey(Schema.Finite),
  }),
});

const isModelsDevModel = Schema.is(ModelsDevModel);

export const ModelsDev = Schema.Record(
  Schema.String,
  Schema.Struct({ models: Schema.Record(Schema.String, Schema.Json) }),
);

/** USD per token as USD per million, without the float noise of the multiplication. */
const perMillion = (usd: number) => Math.round(usd * 1e12) / 1e6;

const fromLiteLlm = (entry: typeof LiteLlmEntry.Type): ModelPrice => ({
  input: perMillion(entry.input_cost_per_token),
  ...(entry.cache_read_input_token_cost === undefined
    ? {}
    : { cachedInput: perMillion(entry.cache_read_input_token_cost) }),
  output: perMillion(entry.output_cost_per_token),
});

const fromModelsDev = ({ cost }: typeof ModelsDevModel.Type): ModelPrice => ({
  input: cost.input,
  ...(cost.cache_read === undefined ? {} : { cachedInput: cost.cache_read }),
  output: cost.output,
});

/** The priced models of one of models.dev's providers, by lower-cased id. */
const modelsOf = (table: typeof ModelsDev.Type, provider: string) =>
  Object.entries(table[provider]?.models ?? {}).flatMap(([id, model]) =>
    isModelsDevModel(model) ? [[id.toLowerCase(), fromModelsDev(model)] as const] : [],
  );

/** Every model's price the two tables give, by lower-cased name, in name order. */
export const pricesOf = (
  litellm: typeof LiteLlm.Type,
  modelsDev: typeof ModelsDev.Type,
): ReadonlyArray<readonly [string, ModelPrice]> => {
  const bare = new Map<string, { rank: number; price: ModelPrice }>();

  for (const [rank, maker] of MAKERS.entries()) {
    for (const [model, price] of modelsOf(modelsDev, maker)) {
      if (!bare.has(model)) bare.set(model, { rank, price });
    }
  }

  const fromModelsDevMakers = new Set(bare.keys());

  for (const [key, value] of Object.entries(litellm)) {
    if (!isLiteLlmEntry(value) || key.startsWith("ft:")) continue;
    const model = (key.split("/").at(-1) ?? key).toLowerCase();
    const rank = PROVIDERS.indexOf(value.litellm_provider);
    const current = bare.get(model);

    // models.dev's maker prices stand; LiteLLM fills in what they leave out.
    if (fromModelsDevMakers.has(model)) continue;

    if (current === undefined || rank < current.rank) {
      bare.set(model, { rank, price: fromLiteLlm(value) });
    }
  }

  const prefixed = PREFIXED.flatMap((provider) =>
    modelsOf(modelsDev, provider).map(([model, price]) => [`${provider}/${model}`, price] as const),
  );

  return [...[...bare].map(([model, { price }]) => [model, price] as const), ...prefixed].toSorted(
    ([a], [b]) => a.localeCompare(b),
  );
};

const line = (model: string, price: ModelPrice) => {
  const cached = price.cachedInput === undefined ? "" : ` cachedInput: ${price.cachedInput},`;

  return `  [${JSON.stringify(model)}, { input: ${price.input},${cached} output: ${price.output} }],`;
};

export const LITELLM =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const MODELS_DEV = "https://models.dev/api.json";

/** The source of `src/price-snapshot.ts` for `prices`. */
export const snapshotSource = (prices: ReadonlyArray<readonly [string, ModelPrice]>) =>
  [
    "// Generated by `bun run prices:update` from models.dev's api.json",
    `// (${MODELS_DEV}) and LiteLLM's model_prices_and_context_window.json`,
    `// (${LITELLM}), both MIT-licensed. Don't edit it by hand.`,
    'import type { ModelPrice } from "@via/config";',
    "",
    "/**",
    " * Prices by lower-cased model name, in USD per million tokens: a provider's",
    " * own under `<provider>/<model>`, and the rest without a provider prefix.",
    " */",
    "export const priceSnapshot: ReadonlyMap<string, ModelPrice> = new Map<string, ModelPrice>([",
    ...prices.map(([model, price]) => line(model, price)),
    "]);",
    "",
  ].join("\n");
