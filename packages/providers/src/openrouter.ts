import { Clock, Effect, Schema } from "effect";
import { HttpClientResponse } from "effect/unstable/http";
import { OpenrouterKeyRejectedError, OpenrouterUnavailableError } from "./errors.ts";
import { budgetOf } from "./openrouter-budget.ts";
import { keyed, LOOKUP_TIMEOUT, probe, type Provider, unansweredWithin } from "./provider.ts";

/** The provider an OpenRouter key added in the web UI goes by. */
export const OPENROUTER = "openrouter";

/** A model OpenRouter lists, with what it costs per token and how much it reads. */
const OpenrouterModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  pricing: Schema.optionalKey(
    Schema.Struct({
      prompt: Schema.optionalKey(Schema.String),
      completion: Schema.optionalKey(Schema.String),
    }),
  ),
  context_length: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});

const OpenrouterModels = Schema.Struct({ data: Schema.Array(OpenrouterModel) });

/**
 * A price per token, as OpenRouter writes it, per million tokens; none when it
 * gives none, a blank, or a negative one, such as the -1 of a router whose
 * price is that of the model it picks.
 */
const perMillion = (perToken: string | undefined) => {
  if (perToken === undefined || perToken.trim() === "") return null;
  const value = Number(perToken);

  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null;
};

/** The unavailable error for `reason`. */
const openrouterDown = (reason: string) => new OpenrouterUnavailableError({ reason });

/** Checks `apiKey` with OpenRouter, by asking what it knows of the key. */
export const verifyOpenrouter = (provider: Provider) =>
  probe(provider, "/key").pipe(
    Effect.catchTags({
      ProviderKeyRefusedError: ({ status }) =>
        Effect.fail(new OpenrouterKeyRejectedError({ status })),
      ProviderUnreachableError: ({ reason }) => Effect.fail(openrouterDown(reason)),
    }),
  );

/** What OpenRouter tells of a key: its limit, what's left of it, and how often it resets. */
const OpenrouterKeyInfo = Schema.Struct({
  data: Schema.Struct({
    limit: Schema.NullOr(Schema.Finite),
    limit_remaining: Schema.NullOr(Schema.Finite),
    limit_reset: Schema.NullOr(Schema.Literals(["daily", "weekly", "monthly"])),
  }),
});

const unreadableBudget = "OpenRouter answered with a key budget via can't read";

/** The budget of `provider`'s key, as OpenRouter tells it, or why it couldn't be read. */
export const budgetFrom = (provider: Provider) =>
  keyed(provider.client, provider.apiKey)
    .get("/key")
    .pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status === 401 || response.status === 403) {
            return { error: `OpenRouter refused its key (HTTP ${response.status})` };
          }

          if (response.status !== 200) {
            return { error: `OpenRouter didn't tell the key's budget (HTTP ${response.status})` };
          }

          const { data } = yield* HttpClientResponse.schemaBodyJson(OpenrouterKeyInfo)(response);

          return { budget: budgetOf(data, yield* Clock.currentTimeMillis) };
        }),
      ),
      // A budget that can't be read is reported, not a failure: the card says why, in words.
      Effect.timeoutOrElse({
        duration: LOOKUP_TIMEOUT,
        orElse: () =>
          Effect.succeed({ error: `OpenRouter gave ${unansweredWithin(LOOKUP_TIMEOUT)}` }),
      }),
      // An HTTP error with a response came from an answer, such as a page, that isn't JSON.
      Effect.catchTags({
        HttpClientError: (error) =>
          Effect.succeed({
            error:
              error.response === undefined ? "OpenRouter couldn't be reached" : unreadableBudget,
          }),
        SchemaError: () => Effect.succeed({ error: unreadableBudget }),
      }),
    );

/** Every model OpenRouter lists, to pick which via offers. */
export const catalogOf = (provider: Provider) =>
  keyed(provider.client, provider.apiKey)
    .get("/models")
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenrouterModels)),
      Effect.timeout(LOOKUP_TIMEOUT),
      Effect.map(({ data }) =>
        data.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          inputPerMillion: perMillion(model.pricing?.prompt),
          outputPerMillion: perMillion(model.pricing?.completion),
          contextLength: model.context_length ?? null,
        })),
      ),
      Effect.mapError(() => openrouterDown("it didn't list its models")),
    );
