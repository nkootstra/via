import type { Model } from "../api/types.ts";

/**
 * The reasoning efforts a Codex model id can end in, as `@via/codex-upstream`
 * lists them. An effort missing here only shows as a model of its own.
 */
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

/** A model as the page shows it: once, with the efforts its suffixed ids pick. */
export interface ModelEntry {
  readonly model: Model;
  /** Who serves it: a provider's id, or `Codex`. */
  readonly owner: string;
  /** Its id without the provider's `<provider>/` prefix. */
  readonly name: string;
  readonly efforts: ReadonlyArray<string>;
  /** Every id a client can ask for it by. */
  readonly ids: ReadonlyArray<string>;
}

/**
 * Who serves a model, from its id: via names a provider's models `<provider>/<model>`,
 * and Codex's have no prefix. `owned_by` is the provider's own say, so it can't be trusted.
 */
export const ownerOf = (id: string) => {
  const slash = id.indexOf("/");

  return slash > 0 ? id.slice(0, slash) : "Codex";
};

/** A model's id without its provider's `<provider>/` prefix, as the pages show it. */
export const withoutPrefix = (id: string) => {
  const owner = ownerOf(id);

  return owner === "Codex" ? id : id.slice(owner.length + 1);
};

/**
 * The listed model `id` picks an effort of, and which: only a suffix on an id
 * that is listed bare, so `gpt-5.5-mini` or `qwen3-max` stay models of their own.
 */
const variantOf = (id: string, listed: ReadonlySet<string>) => {
  const effort = EFFORTS.find(
    (suffix) => id.endsWith(`-${suffix}`) && listed.has(id.slice(0, -(suffix.length + 1))),
  );

  return effort === undefined ? undefined : { base: id.slice(0, -(effort.length + 1)), effort };
};

/** `models` folded into one entry each, their effort variants gathered in. */
export const modelEntries = (models: ReadonlyArray<Model>): ReadonlyArray<ModelEntry> => {
  const listed = new Set(models.map((model) => model.id));
  const variants = models.flatMap((model) => variantOf(model.id, listed) ?? []);
  const efforts = Map.groupBy(variants, (variant) => variant.base);

  return models.flatMap((model) => {
    if (variantOf(model.id, listed) !== undefined) {
      return [];
    }

    const owner = ownerOf(model.id);
    const picked = (efforts.get(model.id) ?? []).map((variant) => variant.effort);

    return [
      {
        model,
        owner,
        name: withoutPrefix(model.id),
        efforts: picked,
        ids: [model.id, ...picked.map((effort) => `${model.id}-${effort}`)],
      },
    ];
  });
};
