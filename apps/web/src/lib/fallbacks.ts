import type { Fallback } from "../api/types.ts";
import { withoutPrefix } from "./model-entries.ts";

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
