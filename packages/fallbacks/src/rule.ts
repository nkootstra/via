// What a fallback rule is, for the store, the admin API's contract and the web UI alike.
// It imports only `effect`, so the contract bundles for a browser without the store.
import { Effect, Schema } from "effect";

/** How many models one model may fall back to: each can wait out a start timeout. */
const MAX_FALLBACKS = 3;

const ModelId = Schema.String.check(
  Schema.makeFilter((id) => id.length > 0 || "Name a model"),
  Schema.makeFilter((id) => id.length <= 200 || "A model id is at most 200 characters"),
  // A model id goes back to the client in a header: none has a space or a control character.
  Schema.makeFilter(
    (id) => !/[\s\p{Cc}]/u.test(id) || "A model id has no spaces or control characters",
  ),
);

/** The first id `ids` lists twice, if any. */
const repeated = (ids: ReadonlyArray<string>) => ids.find((id, index) => ids.indexOf(id) !== index);

/**
 * A model and the models via tries, in order, when it can't serve a request:
 * at least one and at most `MAX_FALLBACKS`, none of them the model itself or
 * listed twice. Ids are as clients ask for them, a provider's with its prefix.
 */
export const FallbackRule = Schema.Struct({
  model: ModelId,
  fallbacks: Schema.Array(ModelId).check(
    Schema.makeFilter((ids) => ids.length > 0 || "Add at least one model to fall back to"),
    Schema.makeFilter(
      (ids) =>
        ids.length <= MAX_FALLBACKS || `A model can fall back to at most ${MAX_FALLBACKS} others`,
    ),
    Schema.makeFilter((ids) => {
      const twice = repeated(ids);

      return twice === undefined || `${twice} is in the list twice`;
    }),
  ),
}).check(
  Schema.makeFilter(
    ({ model, fallbacks }) => !fallbacks.includes(model) || `${model} can't fall back to itself`,
  ),
);

export type FallbackRule = typeof FallbackRule.Type;

/** Every rule, at most one per model, as the file keeps them. */
export const FallbackRules = Schema.Array(FallbackRule).check(
  Schema.makeFilter((rules) => {
    const twice = repeated(rules.map((rule) => rule.model));

    return twice === undefined || `${twice} has two rules`;
  }),
);

export class FallbackRuleNotFoundError extends Schema.TaggedError<FallbackRuleNotFoundError>()(
  "FallbackRuleNotFoundError",
  { model: Schema.String },
) {
  override get message() {
    return `No fallbacks are set for ${this.model}`;
  }
}

/** A rule via can't keep, with why, in words a person can act on. */
export class FallbackRuleInvalidError extends Schema.TaggedError<FallbackRuleInvalidError>()(
  "FallbackRuleInvalidError",
  { problem: Schema.String },
) {
  override get message() {
    return this.problem;
  }
}

/**
 * `input`, a rule as a person or client wrote it, as a rule via can keep, or
 * the first thing wrong with it, without where in the rule it is.
 */
export const parseRule = (input: {
  readonly model: string;
  readonly fallbacks: ReadonlyArray<string>;
}) =>
  Schema.decodeUnknownEffect(FallbackRule)(input).pipe(
    Effect.mapError(
      (error) =>
        new FallbackRuleInvalidError({ problem: error.message.split("\n")[0] ?? error.message }),
    ),
  );
