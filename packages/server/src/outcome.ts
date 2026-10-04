import { Data, Effect } from "effect";
import type { HttpServerResponse } from "effect/unstable/http";

/**
 * How a request for one model went: `Answered` with what the client gets, a
 * success or a refusal of the request itself, or `Unavailable` because the
 * model can't be served now, decided before any of its answer went out, so
 * another model may still take the request. An `Unavailable` response holds
 * no upstream stream, so it can be dropped for free.
 */
export type Outcome = Data.TaggedEnum<{
  Answered: { readonly response: HttpServerResponse.HttpServerResponse };
  Unavailable: {
    readonly response: HttpServerResponse.HttpServerResponse;
    readonly reason: string;
  };
}>;

export const Outcome = Data.taggedEnum<Outcome>();

/** `response` as an `Answered` outcome. */
export const answered = <E, R>(
  response: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.map(response, (sent): Outcome => Outcome.Answered({ response: sent }));

/** `response` as the outcome of a model unavailable for `reason`. */
export const unavailable = <E, R>(
  reason: string,
  response: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.map(response, (sent): Outcome => Outcome.Unavailable({ response: sent, reason }));

/** The response an outcome sends the client. */
export const responseOf = (outcome: Outcome) => outcome.response;
