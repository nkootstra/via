/** Reasoning efforts a client can pick by suffixing a model id, as in `gpt-6-astra-high`. */
export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

type Effort = (typeof EFFORTS)[number];

/** Models the Codex backend serves to ChatGPT sign-in, with the efforts each supports. */
const CATALOG: ReadonlyArray<readonly [model: string, efforts: ReadonlyArray<Effort>]> = [
  ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
  ["gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max", "ultra"]],
  ["gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"]],
];

export const MODELS = CATALOG.map(([model]) => model);

/** Splits an effort suffix alias into its base model and reasoning effort. */
export const resolveAlias = (model: string) => {
  const effort = EFFORTS.find((suffix) => model.endsWith(`-${suffix}`));
  return effort === undefined ? { model } : { model: model.slice(0, -(effort.length + 1)), effort };
};

/** The ids `/v1/models` lists: every model, then each with every effort suffix it supports. */
export const modelIds = (): ReadonlyArray<string> => [
  ...MODELS,
  ...CATALOG.flatMap(([model, efforts]) => efforts.map((effort) => `${model}-${effort}`)),
];
