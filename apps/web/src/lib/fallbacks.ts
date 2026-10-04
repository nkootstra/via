import type { Fallback } from "../api/types.ts";

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
