/** A model an account can pick, with the reasoning efforts it supports. */
export type CatalogModel = { readonly model: string; readonly efforts: ReadonlyArray<string> };

/** Reasoning efforts a client can pick by suffixing a model id, as in `gpt-6-astra-high`. */
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

const isEffort = (effort: string): effort is (typeof EFFORTS)[number] =>
  EFFORTS.some((known) => known === effort);

/**
 * Whether `effort` is one only the Codex app can run: Codex lists `ultra`, which
 * is maximum reasoning with tasks delegated to agents the app runs, but its API
 * refuses it.
 */
const isCodexAppOnly = (effort: string | undefined) => effort === "ultra";

/**
 * The models the Codex backend serves to ChatGPT sign-in, with the efforts each
 * supports: what via lists when it cannot ask Codex itself.
 */
export const BUNDLED: ReadonlyArray<CatalogModel> = [
  { model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "gpt-6-sol", efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
  { model: "gpt-6-luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
];

/**
 * Splits an effort suffix alias into its base model and reasoning effort. A
 * model `catalog` lists by that name, such as `gpt-5.1-codex-max`, is no alias.
 */
export const resolveAlias = (model: string, catalog: ReadonlyArray<CatalogModel> = BUNDLED) => {
  if (catalog.some((listed) => listed.model === model)) return { model };

  const effort = EFFORTS.find((suffix) => model.endsWith(`-${suffix}`));

  return effort === undefined ? { model } : { model: model.slice(0, -(effort.length + 1)), effort };
};

/**
 * The ids `/v1/models` lists: every model in `catalog`, then each with every
 * effort suffix it supports that `resolveAlias` understands, but those only
 * the Codex app can run.
 */
export const modelIds = (catalog: ReadonlyArray<CatalogModel> = BUNDLED): ReadonlyArray<string> => [
  ...catalog.map(({ model }) => model),
  ...catalog.flatMap(({ model, efforts }) =>
    efforts
      .filter((effort) => isEffort(effort) && !isCodexAppOnly(effort))
      .map((effort) => `${model}-${effort}`),
  ),
];
