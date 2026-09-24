import type { CatalogModel } from "./codex-upstream.ts";

/** Reasoning efforts a client can pick by suffixing a model id, as in `gpt-6-astra-high`. */
export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

const isEffort = (effort: string): effort is (typeof EFFORTS)[number] =>
  EFFORTS.some((known) => known === effort);

/**
 * The models the Codex backend serves to ChatGPT sign-in, with the efforts each
 * supports: what via lists when it cannot ask Codex itself.
 */
const BUNDLED: ReadonlyArray<CatalogModel> = [
  { model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { model: "gpt-6-sol", efforts: ["none", "low", "medium", "high", "xhigh", "max", "ultra"] },
  { model: "gpt-6-luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
];

/** Splits an effort suffix alias into its base model and reasoning effort. */
export const resolveAlias = (model: string) => {
  const effort = EFFORTS.find((suffix) => model.endsWith(`-${suffix}`));
  return effort === undefined ? { model } : { model: model.slice(0, -(effort.length + 1)), effort };
};

/**
 * The ids `/v1/models` lists: every model in `catalog`, then each with every
 * effort suffix it supports that `resolveAlias` understands.
 */
export const modelIds = (catalog: ReadonlyArray<CatalogModel> = BUNDLED): ReadonlyArray<string> => [
  ...catalog.map(({ model }) => model),
  ...catalog.flatMap(({ model, efforts }) =>
    efforts.filter(isEffort).map((effort) => `${model}-${effort}`),
  ),
];
