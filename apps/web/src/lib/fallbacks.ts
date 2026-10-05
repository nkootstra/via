import type { Availability, Fallback } from "../api/types.ts";
import { type ModelEntry, withoutPrefix } from "./model-entries.ts";

/**
 * How a rule stands, from who would answer a request for its model now: the
 * model itself, one of its fallbacks, or none of them.
 */
export type Standing =
  | { readonly state: "standing-by" }
  | { readonly state: "falling-back"; readonly to: string }
  | { readonly state: "none" };

export const standingOf = ({ model, status }: Fallback): Standing =>
  status.serving === null
    ? { state: "none" }
    : status.serving === model
      ? { state: "standing-by" }
      : { state: "falling-back", to: status.serving };

/**
 * Why via skips `target` when it falls back, if it does: a model it has no
 * account for, one not enabled, or one it doesn't list at all. A model cooling
 * down is only resting, so that's no reason.
 */
export const skipped = (
  target: string,
  availability: Availability | undefined,
  listed: ReadonlySet<string>,
) => {
  const name = withoutPrefix(target);

  if (availability?.status === "unavailable") {
    return availability.reason === "not_enabled"
      ? `${name} isn't enabled, so via skips it.`
      : `${name} has no account to serve it, so via skips it.`;
  }

  return listed.has(target) ? undefined : `${name} isn't in the models list, so via skips it.`;
};

/** How many models one model may fall back to, as via allows. */
export const MAX_FALLBACKS = 3;

/**
 * The first thing wrong with a rule, in via's own words, so the form says it
 * before via has to; undefined when nothing is.
 */
export const problemOf = (model: string, fallbacks: ReadonlyArray<string>) => {
  const twice = fallbacks.find((id, index) => fallbacks.indexOf(id) !== index);

  if (fallbacks.length === 0) return "Add at least one model to fall back to";

  if (fallbacks.length > MAX_FALLBACKS) {
    return `A model can fall back to at most ${MAX_FALLBACKS} others`;
  }

  if (twice !== undefined) return `${twice} is in the list twice`;

  return fallbacks.includes(model) ? `${model} can't fall back to itself` : undefined;
};

/**
 * What a request for one of `source`'s efforts gets from `target`, when it
 * can't keep the effort: via carries an effort only to a Codex model that
 * lists it, and sends the model as written otherwise.
 */
export const effortHint = (source: string, target: string, entries: ReadonlyArray<ModelEntry>) => {
  const efforts = entries.find((entry) => entry.model.id === source)?.efforts ?? [];
  const has = entries.find((entry) => entry.model.id === target)?.efforts ?? [];
  const name = withoutPrefix(target);

  if (efforts.length === 0) return undefined;

  if (has.length === 0) {
    return `${name} has no reasoning efforts: a request for ${source}-${efforts.at(-1)} gets it at its default.`;
  }

  const missing = efforts.findLast((effort) => !has.includes(effort));

  return missing === undefined
    ? undefined
    : `${name} has no ${missing} effort: a request for ${source}-${missing} gets it at its default.`;
};

/** Two standings alike: the same state, falling back to the same model. */
export const sameStanding = (a: Standing, b: Standing) =>
  a.state === b.state &&
  (a.state !== "falling-back" || b.state !== "falling-back" || a.to === b.to);

/** What a screen reader hears once `model`'s rule comes to stand as `standing`. */
export const announcement = (model: string, standing: Standing) => {
  const name = withoutPrefix(model);

  switch (standing.state) {
    case "standing-by":
      return `${name} is answering again.`;
    case "falling-back":
      return `${name} is falling back to ${withoutPrefix(standing.to)}.`;
    case "none":
      return `${name} has no fallback available, so its requests fail.`;
  }
};
