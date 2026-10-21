/** A turn's upstream attempts, as the conversation's timeline names them. */
import { Option } from "effect";
import type { TurnAttempt } from "../api/types.ts";

type Category = Option.Option.Value<TurnAttempt["category"]>;

/** Why an attempt didn't serve, in a word or two; the category itself is the title. */
export const categoryNames: Readonly<Record<Category, string>> = {
  budget_exhausted: "Budget exhausted",
  rate_limited: "Rate limited",
  auth: "Not authorized",
  downstream_unavailable: "Downstream unavailable",
  context_too_long: "Context too long",
  content_filtered: "Content filtered",
  bad_request: "Bad request",
  timeout: "Timed out",
  network: "Network error",
  unknown: "Unknown error",
};

/** How an attempt ended, in a word. */
export const attemptOutcomeNames: Readonly<Record<TurnAttempt["outcome"], string>> = {
  served: "Served",
  refused: "Refused",
  failed: "Failed",
};

/** Whether an attempt that ended didn't serve: via tried the next one, or the client got its refusal. */
export const didNotServe = (attempt: Pick<TurnAttempt, "outcome">) => attempt.outcome !== "served";
