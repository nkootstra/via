import { type CatalogModel, resolveAlias } from "@via/codex-upstream";
import { type FallbackRule, FallbackRuleStore } from "@via/fallbacks";
import { Effect, Option, type Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { ModelCatalog } from "./catalog.ts";
import { modelOf } from "./dispatch.ts";
import { Providers } from "@via/providers";
import { Outcome } from "./outcome.ts";
import { RequestLog } from "./request-log.ts";

/**
 * `target` for a request that asked for reasoning `effort`: a Codex model
 * that `catalog` lists with that effort gets it as its suffix; a provider's
 * model, one that already names an effort, or one without that effort is
 * used as written.
 */
const withEffort = (target: string, effort: string, catalog: ReadonlyArray<CatalogModel>) => {
  if (target.includes("/") || resolveAlias(target, catalog).effort !== undefined) return target;

  const listed = catalog.find(({ model }) => model === target);

  return listed?.efforts.includes(effort) === true ? `${target}-${effort}` : target;
};

/**
 * The models to try, in order, when `requested` can't serve: its own rule's,
 * as written, else, for a Codex model asked for with an effort suffix, its
 * base model's rule's, each keeping the effort where it has it. Never the
 * model asked for, nor one model twice; a fallback's own rule isn't followed.
 */
export const candidatesFor = (
  rules: ReadonlyArray<FallbackRule>,
  requested: string,
  catalog: ReadonlyArray<CatalogModel>,
): ReadonlyArray<string> => {
  const exact = rules.find(({ model }) => model === requested);

  if (exact !== undefined) return exact.fallbacks;

  if (requested.includes("/")) return [];

  const { model: base, effort } = resolveAlias(requested, catalog);
  const rule = rules.find(({ model }) => model === base);

  if (effort === undefined || rule === undefined) return [];

  const candidates = rule.fallbacks.map((target) => withEffort(target, effort, catalog));

  return [...new Set(candidates)].filter((candidate) => candidate !== requested);
};

/** The seconds a response's `Retry-After` asks to wait, when it gives them as a number. */
const retryAfterOf = (response: HttpServerResponse.HttpServerResponse) =>
  Option.liftPredicate(Number(response.headers["retry-after"]), Number.isFinite);

/**
 * `response` asking to retry after the soonest any of `responses` asks: a retry
 * tries every model again, so it can succeed once any of them can serve.
 */
const soonestRetry = (
  response: HttpServerResponse.HttpServerResponse,
  responses: ReadonlyArray<HttpServerResponse.HttpServerResponse>,
) => {
  const waits = responses.flatMap((each) => Option.toArray(retryAfterOf(each)));

  return waits.length === 0
    ? response
    : HttpServerResponse.setHeader(response, "retry-after", String(Math.min(...waits)));
};

/**
 * Whether via knows `model`: a provider's model is, as its provider says whether it has it;
 * a Codex model is when Codex lists it, with or without an effort suffix.
 */
const isListed = Effect.fn("isListed")(function* (model: string) {
  if (Option.isSome((yield* Providers).route(model))) return true;

  const catalog = yield* (yield* ModelCatalog).codex;
  const base = resolveAlias(model, catalog).model;

  return catalog.some((listed) => listed.model === base);
});

/** The rules, or none when their file can't be read: a fallback is never why a request fails. */
const rulesNow = Effect.flatMap(FallbackRuleStore, (store) => store.list).pipe(
  Effect.catch((error) =>
    Effect.as(Effect.logWarning("Could not read the fallback rules", error), []),
  ),
);

/**
 * Answers `body` with `attempt`, and when its model can't serve, with the models
 * its fallback rule names (see `candidatesFor`), in order, the body asking for
 * each in turn: the first that answers does, its answer saying so in
 * `x-via-fallback`. When none can, the client gets its own model's answer,
 * asking to retry as soon as any of them may serve. The rules are only read
 * once the model couldn't serve, so a request it serves costs nothing more.
 */
export const withFallbacks = Effect.fn("withFallbacks")(function* <E, R>(
  body: Schema.JsonObject,
  attempt: (body: Schema.JsonObject) => Effect.Effect<Outcome, E, R>,
) {
  const first = yield* attempt(body);
  const requested = modelOf(body);

  if (Outcome.$is("Answered")(first) || Option.isNone(requested)) return first.response;

  const candidates = candidatesFor(
    yield* rulesNow,
    requested.value,
    yield* (yield* ModelCatalog).codex,
  );

  if (candidates.length === 0) return first.response;

  const log = yield* RequestLog;
  const restore = yield* log.setAside;
  const failed = [first.response];
  let previous = { model: requested.value, reason: first.reason };

  for (const candidate of candidates) {
    yield* Effect.logInfo(
      `${previous.model} can't serve (${previous.reason}), so ${candidate} is asked instead`,
    );

    // A model via doesn't know would only be refused: it can't serve, as one that is down can't.
    if (!(yield* isListed(candidate))) {
      previous = { model: candidate, reason: "not_listed" };
      continue;
    }

    yield* log.fellBack(requested.value, first.reason);

    const outcome = yield* attempt({ ...body, model: candidate });

    if (Outcome.$is("Answered")(outcome)) {
      return HttpServerResponse.setHeader(
        outcome.response,
        "x-via-fallback",
        `${requested.value} -> ${candidate}`,
      );
    }

    failed.push(outcome.response);
    previous = { model: candidate, reason: outcome.reason };
    yield* Effect.asVoid(log.setAside);
  }

  // None could serve: the line says what the model asked for did, as without a rule.
  yield* restore;

  return soonestRetry(first.response, failed);
});
