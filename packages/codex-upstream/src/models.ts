/** Models the Codex backend serves to ChatGPT subscriptions. */
export const MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"] as const;

/** Reasoning efforts a client can pick by suffixing a model id, as in `gpt-5.5-high`. */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** Splits an effort suffix alias into its base model and reasoning effort. */
export const resolveAlias = (model: string) => {
  const effort = EFFORTS.find((suffix) => model.endsWith(`-${suffix}`));
  return effort === undefined ? { model } : { model: model.slice(0, -(effort.length + 1)), effort };
};

/** The ids `/v1/models` lists: every model, then each with every effort suffix. */
export const modelIds = (): ReadonlyArray<string> => [
  ...MODELS,
  ...MODELS.flatMap((model) => EFFORTS.map((effort) => `${model}-${effort}`)),
];
