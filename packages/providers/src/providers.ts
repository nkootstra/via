import type { ProviderConfig } from "@via/config";
import { Config, Context, Effect, identity, Layer, Option, Redacted, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/** Where a request goes: a configured provider and the model id it knows. */
export type Route = { provider: string; model: string };

/** The paths via forwards to an OpenAI-compatible provider. */
export type ProviderPath = "/chat/completions" | "/responses";

/**
 * Where a provider wants the conversation's session id, so it can keep the
 * conversation on a warm prompt cache.
 */
type SessionTarget = { header: string } | "body" | undefined;

/** Providers via knows, so config.yaml only needs their API key. */
const PRESETS: Record<string, { baseUrl: string; session: SessionTarget }> = {
  // https://openrouter.ai/docs/guides/best-practices/prompt-caching
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", session: "body" },
  // https://opencode.ai/docs/go/
  "opencode-go": {
    baseUrl: "https://opencode.ai/zen/go/v1",
    session: { header: "x-opencode-session" },
  },
};

export class UnknownProviderError extends Schema.TaggedError<UnknownProviderError>()(
  "UnknownProviderError",
  { name: Schema.String },
) {
  override get message() {
    return `Provider "${this.name}" is not built in, so it needs a baseUrl`;
  }
}

export class MissingApiKeyError extends Schema.TaggedError<MissingApiKeyError>()(
  "MissingApiKeyError",
  { provider: Schema.String, variable: Schema.String },
) {
  override get message() {
    return `Provider "${this.provider}" reads its API key from ${this.variable}, which is not set`;
  }
}

/** A model as a provider describes it: an id, plus whatever else it tells. */
const Model = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
export type ProviderModel = typeof Model.Type;

const ModelList = Schema.Struct({ data: Schema.Array(Model) });

type Provider = { baseUrl: string; apiKey: Redacted.Redacted; session: SessionTarget };

export interface ProvidersShape {
  /** The provider a `<provider>/<model>` id names, if it is configured. */
  readonly route: (model: unknown) => Option.Option<Route>;
  /** The base URL requests to `provider` go to. */
  readonly baseUrl: (provider: string) => string | undefined;
  /**
   * Every provider's models as it describes them, with `<provider>/<model>`
   * ids; a provider that can't list them is left out.
   */
  readonly models: Effect.Effect<ReadonlyArray<{ provider: string; model: ProviderModel }>>;
  /**
   * Posts `body` to the route's provider, with its model in place of via's and
   * `session` where the provider looks for it.
   */
  readonly send: (
    route: Route,
    path: ProviderPath,
    body: Record<string, unknown>,
    session: string,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
}

const make = (configs: Record<string, ProviderConfig>, version: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const providers = new Map<string, Provider>();
    for (const [name, config] of Object.entries(configs)) {
      const baseUrl = config.baseUrl ?? PRESETS[name]?.baseUrl;
      if (baseUrl === undefined) return yield* new UnknownProviderError({ name });
      providers.set(name, {
        baseUrl,
        apiKey: yield* Config.Redacted(config.apiKeyEnv).pipe(
          Effect.mapError(
            () => new MissingApiKeyError({ provider: name, variable: config.apiKeyEnv }),
          ),
        ),
        session:
          config.sessionHeader === undefined
            ? PRESETS[name]?.session
            : { header: config.sessionHeader },
      });
    }

    const authorized = (provider: Provider, request: HttpClientRequest.HttpClientRequest) =>
      request.pipe(
        HttpClientRequest.bearerToken(Redacted.value(provider.apiKey)),
        HttpClientRequest.setHeader("user-agent", `via/${version}`),
      );

    const list = (name: string, provider: Provider) =>
      http.execute(authorized(provider, HttpClientRequest.get(`${provider.baseUrl}/models`))).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelList)),
        Effect.map(({ data }) =>
          data.map((model) => ({ provider: name, model: { ...model, id: `${name}/${model.id}` } })),
        ),
        // A provider that is down or answers oddly just has no models to offer now.
        Effect.orElseSucceed(() => []),
      );

    return Providers.of({
      models: Effect.forEach([...providers], ([name, provider]) => list(name, provider), {
        concurrency: "unbounded",
      }).pipe(Effect.map((lists) => lists.flat())),
      route: (model) => {
        if (typeof model !== "string") return Option.none();
        const slash = model.indexOf("/");
        const provider = model.slice(0, slash);
        return slash > 0 && providers.has(provider)
          ? Option.some({ provider, model: model.slice(slash + 1) })
          : Option.none();
      },
      baseUrl: (provider) => providers.get(provider)?.baseUrl,
      send: Effect.fn("Providers.send")(function* (route, path, body, session) {
        // `route` comes from `route`, so its provider is configured.
        const provider = providers.get(route.provider);
        if (provider === undefined) return yield* Effect.die(`unrouted provider ${route.provider}`);
        return yield* authorized(
          provider,
          HttpClientRequest.post(`${provider.baseUrl}${path}`),
        ).pipe(
          typeof provider.session === "object"
            ? HttpClientRequest.setHeader(provider.session.header, session)
            : identity,
          // A raw string goes to fetch as-is; bodyJsonUnsafe would copy it into bytes first.
          HttpClientRequest.setBody(
            HttpBody.raw(
              JSON.stringify(
                provider.session === "body"
                  ? { prompt_cache_key: session, ...body, model: route.model, session_id: session }
                  : { ...body, model: route.model },
              ),
              { contentType: "application/json" },
            ),
          ),
          http.execute,
        );
      }),
    });
  });

/** The OpenAI-compatible providers configured in config.yaml. */
export class Providers extends Context.Service<Providers, ProvidersShape>()("via/Providers") {
  /**
   * Reads each provider's API key from the environment variable its config
   * names, and says it is `via/<version>`.
   */
  static readonly layer = (configs: Record<string, ProviderConfig>, version: string) =>
    Layer.effect(Providers, make(configs, version));
}
