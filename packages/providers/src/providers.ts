import type { ProviderConfig } from "@via/config";
import { Context, Effect, identity, Layer, Option, Predicate, type Redacted, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { ProviderUsage } from "./schemas.ts";

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
const PRESETS = new Map<string, { baseUrl: string; session: SessionTarget; usagePath?: string }>([
  // https://openrouter.ai/docs/guides/best-practices/prompt-caching
  ["openrouter", { baseUrl: "https://openrouter.ai/api/v1", session: "body" }],
  // https://opencode.ai/docs/go/
  [
    "opencode-go",
    {
      baseUrl: "https://opencode.ai/zen/go/v1",
      session: { header: "x-opencode-session" },
      usagePath: "/usage",
    },
  ],
]);

class UnknownProviderError extends Schema.TaggedError<UnknownProviderError>()(
  "UnknownProviderError",
  { name: Schema.String },
) {
  override get message() {
    return `Provider "${this.name}" is not built in, so it needs a baseUrl`;
  }
}

class MissingApiKeyError extends Schema.TaggedError<MissingApiKeyError>()("MissingApiKeyError", {
  provider: Schema.String,
  variable: Schema.String,
}) {
  override get message() {
    return `Provider "${this.provider}" reads its API key from ${this.variable}, which is not set`;
  }
}

/** A provider answered its usage endpoint with something other than 200. */
class ProviderUsageUnavailableError extends Schema.TaggedError<ProviderUsageUnavailableError>()(
  "ProviderUsageUnavailableError",
  { provider: Schema.String, status: Schema.Finite },
) {
  override get message() {
    return `${this.provider} did not report usage (HTTP ${this.status})`;
  }
}

/** A model as a provider describes it: an id, plus whatever else it tells. */
const Model = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Schema.JsonObject]);

export type ProviderModel = typeof Model.Type;

const ModelList = Schema.Struct({ data: Schema.Array(Model) });

/** OpenCode Go's usage: each window by name, e.g. `rolling`, `weekly` and `monthly`. */
const UsagePayload = Schema.Struct({
  usage: Schema.Record(
    Schema.String,
    Schema.Struct({ status: Schema.String, percent: Schema.Finite, resetsAt: Schema.String }),
  ),
});

type Provider = {
  name: string;
  /** Sends requests under the provider's base URL, with its API key. */
  client: HttpClient.HttpClient;
  session: SessionTarget;
  /** The path of its usage endpoint, for a provider that reports usage. */
  usagePath: string | undefined;
};

/** The provider `name` as its config describes it, filled in from its preset. */
const resolve = (
  http: HttpClient.HttpClient,
  version: string,
  name: string,
  config: ProviderConfig,
  apiKey: Redacted.Redacted<string> | undefined,
) =>
  Effect.gen(function* () {
    const preset = PRESETS.get(name);
    const baseUrl = config.baseUrl ?? preset?.baseUrl;

    if (baseUrl === undefined) return yield* new UnknownProviderError({ name });

    if (apiKey === undefined) {
      return yield* new MissingApiKeyError({ provider: name, variable: config.apiKeyEnv });
    }

    return {
      name,
      client: HttpClient.mapRequest(http, (request) =>
        request.pipe(
          HttpClientRequest.prependUrl(baseUrl),
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.setHeader("user-agent", `via/${version}`),
        ),
      ),
      session:
        config.sessionHeader === undefined ? preset?.session : { header: config.sessionHeader },
      usagePath: preset?.usagePath,
    } satisfies Provider;
  });

/** The provider's models, with `<provider>/<model>` ids. */
const modelsOf = ({ name, client }: Provider) =>
  client.get("/models").pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelList)),
    Effect.map(({ data }) =>
      data.map((model) => ({ provider: name, model: { ...model, id: `${name}/${model.id}` } })),
    ),
    // A provider that is down or answers oddly just has no models to offer now.
    Effect.orElseSucceed(() => []),
  );

/** The usage the provider reports at `path`, or why it couldn't. */
const usageOf = ({ name, client }: Provider, path: string) =>
  Effect.gen(function* () {
    const response = yield* client.get(path);

    if (response.status !== 200) {
      return yield* new ProviderUsageUnavailableError({ provider: name, status: response.status });
    }

    const { usage } = yield* HttpClientResponse.schemaBodyJson(UsagePayload)(response);

    return {
      provider: name,
      windows: Object.entries(usage).map(([window, { status, percent, resetsAt }]) => ({
        window,
        status,
        usedPercent: percent,
        resetsAt,
      })),
    } satisfies ProviderUsage;
  }).pipe(
    // One provider's usage failing, for whatever reason, doesn't hide the others'.
    Effect.catch((error) =>
      Effect.succeed<ProviderUsage>({ provider: name, error: error.message }),
    ),
  );

const make = (
  configs: Record<string, ProviderConfig>,
  apiKeys: Readonly<Record<string, Redacted.Redacted<string>>>,
  version: string,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const providers = new Map<string, Provider>();

    for (const [name, config] of Object.entries(configs)) {
      providers.set(name, yield* resolve(http, version, name, config, apiKeys[name]));
    }

    const configured = [...providers.values()];

    return Providers.of({
      names: [...providers.keys()],
      usage: Effect.all(
        configured.flatMap((provider) =>
          provider.usagePath === undefined ? [] : [usageOf(provider, provider.usagePath)],
        ),
        { concurrency: "unbounded" },
      ),
      models: Effect.forEach(configured, modelsOf, { concurrency: "unbounded" }).pipe(
        Effect.map((lists) => lists.flat()),
      ),
      route: (model) => {
        const slash = model.indexOf("/");
        const provider = model.slice(0, slash);

        return slash > 0 && providers.has(provider)
          ? Option.some({ provider, model: model.slice(slash + 1) })
          : Option.none();
      },
      send: Effect.fn("Providers.send")(function* (route, path, body, session) {
        // `route` comes from `route`, so its provider is configured.
        const provider = providers.get(route.provider);

        if (provider === undefined) return yield* Effect.die(`unrouted provider ${route.provider}`);

        return yield* HttpClientRequest.post(path).pipe(
          Predicate.isObject(provider.session)
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
          provider.client.execute,
        );
      }),
    });
  });

/** The OpenAI-compatible providers configured in config.yaml. */
export class Providers extends Context.Service<
  Providers,
  {
    /** Every configured provider's name, in config.yaml's order. */
    readonly names: ReadonlyArray<string>;
    /** The provider a `<provider>/<model>` id names, if it is configured. */
    readonly route: (model: string) => Option.Option<Route>;
    /**
     * Every provider's models as it describes them, with `<provider>/<model>`
     * ids; a provider that can't list them is left out.
     */
    readonly models: Effect.Effect<ReadonlyArray<{ provider: string; model: ProviderModel }>>;
    /** The usage of every provider that reports it, such as OpenCode Go. */
    readonly usage: Effect.Effect<ReadonlyArray<ProviderUsage>>;
    /**
     * Posts `body` to the route's provider, with its model in place of via's and
     * `session` where the provider looks for it.
     */
    readonly send: (
      route: Route,
      path: ProviderPath,
      body: Schema.JsonObject,
      session: string,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
  }
>()("via/Providers") {
  /**
   * Sends each provider's requests with its key in `apiKeys`, by provider name,
   * and says it is `via/<version>`. A provider without a key fails naming the
   * environment variable its config reads the key from.
   */
  static readonly layer = (options: {
    readonly providers: Record<string, ProviderConfig>;
    readonly apiKeys: Readonly<Record<string, Redacted.Redacted<string>>>;
    readonly version: string;
  }) => Layer.effect(Providers, make(options.providers, options.apiKeys, options.version));
}
