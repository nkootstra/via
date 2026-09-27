import type { ProviderConfig } from "@via/config";
import { Context, Effect, identity, Layer, Option, Predicate, Redacted, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { OpencodeGoKeyRejectedError, OpencodeGoUnavailableError } from "./errors.ts";
import { OpencodeGoAccounts } from "./opencode-go-accounts.ts";
import type { ProviderUsage } from "./schemas.ts";

/**
 * Where a request goes: a provider and the model id it knows. A `pooled`
 * provider, opencode Go, is sent each request with one of its accounts' keys.
 */
export type Route = { provider: string; model: string; pooled: boolean };

/** The paths via forwards to an OpenAI-compatible provider. */
export type ProviderPath = "/chat/completions" | "/responses";

/**
 * Where a provider wants the conversation's session id, so it can keep the
 * conversation on a warm prompt cache.
 */
type SessionTarget = { header: string } | "body" | undefined;

type Preset = {
  baseUrl: string;
  session: SessionTarget;
  usagePath?: string;
  /** Its keys are the accounts via stores, so it is there without any config. */
  pooled?: true;
};

/** The pooled provider: opencode Go, whose API keys via stores as accounts. */
const POOLED = "opencode-go";

/** Providers via knows, so config.yaml only needs their API key. */
const PRESETS = new Map<string, Preset>([
  // https://openrouter.ai/docs/guides/best-practices/prompt-caching
  ["openrouter", { baseUrl: "https://openrouter.ai/api/v1", session: "body" }],
  // https://opencode.ai/docs/go/
  [
    POOLED,
    {
      baseUrl: "https://opencode.ai/zen/go/v1",
      session: { header: "x-opencode-session" },
      usagePath: "/usage",
      pooled: true,
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
  /** Sends requests under the provider's base URL, as via, with no API key yet. */
  client: HttpClient.HttpClient;
  /** Its one API key; none for the pooled provider, whose accounts each have one. */
  apiKey: Redacted.Redacted<string> | undefined;
  session: SessionTarget;
  /** The path of its usage endpoint, for a provider that reports usage. */
  usagePath: string | undefined;
};

/** `client`, sending each request with `apiKey`. */
const keyed = (client: HttpClient.HttpClient, apiKey: Redacted.Redacted<string>) =>
  HttpClient.mapRequest(client, HttpClientRequest.bearerToken(apiKey));

/** The provider `name` as its config describes it, filled in from its preset. */
const resolve = (
  http: HttpClient.HttpClient,
  version: string,
  name: string,
  config: Partial<ProviderConfig>,
  apiKey: Redacted.Redacted<string> | undefined,
) =>
  Effect.gen(function* () {
    const preset = PRESETS.get(name);
    const baseUrl = config.baseUrl ?? preset?.baseUrl;

    if (baseUrl === undefined) return yield* new UnknownProviderError({ name });
    const pooled = preset?.pooled === true;

    if (apiKey === undefined && !pooled) {
      return yield* new MissingApiKeyError({ provider: name, variable: config.apiKeyEnv ?? "" });
    }

    return {
      name,
      client: HttpClient.mapRequest(http, (request) =>
        request.pipe(
          HttpClientRequest.prependUrl(baseUrl),
          HttpClientRequest.setHeader("user-agent", `via/${version}`),
        ),
      ),
      // The pooled provider's key is the one of the account each request is sent as.
      apiKey: pooled ? undefined : apiKey,
      session:
        config.sessionHeader === undefined ? preset?.session : { header: config.sessionHeader },
      usagePath: preset?.usagePath,
    } satisfies Provider;
  });

/** The provider's models, asked with `apiKey`, with `<provider>/<model>` ids. */
const modelsOf = ({ name, client }: Provider, apiKey: Redacted.Redacted<string>) =>
  keyed(client, apiKey)
    .get("/models")
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelList)),
      Effect.map(({ data }) =>
        data.map((model) => ({ provider: name, model: { ...model, id: `${name}/${model.id}` } })),
      ),
      // A provider that is down or answers oddly just has no models to offer now.
      Effect.orElseSucceed(() => []),
    );

/** The usage the provider reports at `path` for `apiKey`, or why it couldn't. */
const usageOf = ({ name, client }: Provider, path: string, apiKey: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const response = yield* keyed(client, apiKey).get(path);

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
    // Usage failing, for whatever reason, is reported rather than failing whoever asked.
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
    const accounts = yield* OpencodeGoAccounts;
    const providers = new Map<string, Provider>();

    for (const [name, config] of Object.entries(configs)) {
      providers.set(name, yield* resolve(http, version, name, config, apiKeys[name]));
    }

    // The pooled provider needs no config: its keys are the accounts via stores.
    const pooled = providers.get(POOLED) ?? (yield* resolve(http, version, POOLED, {}, undefined));
    providers.set(POOLED, pooled);

    /** The key of the pooled provider's first enabled account, for what any of them may ask. */
    const anyAccountKey = accounts.list.pipe(
      Effect.map((all) => Option.fromUndefinedOr(all.find(({ enabled }) => enabled)?.apiKey)),
      // A store via can't read has no key to lend.
      Effect.orElseSucceed(Option.none),
    );

    const keyOf = (provider: Provider) =>
      provider.apiKey === undefined ? anyAccountKey : Effect.succeedSome(provider.apiKey);

    return Providers.of({
      names: [...providers.values()].flatMap(({ name, apiKey }) =>
        apiKey === undefined ? [] : [name],
      ),
      usage: (apiKey) => usageOf(pooled, pooled.usagePath ?? "/usage", apiKey),
      verify: Effect.fn("Providers.verify")(function* (apiKey) {
        const { status } = yield* keyed(pooled.client, apiKey)
          .get(pooled.usagePath ?? "/usage")
          .pipe(
            Effect.catchTag("HttpClientError", () =>
              Effect.fail(new OpencodeGoUnavailableError({ reason: "it could not be reached" })),
            ),
          );

        if (status === 401 || status === 403) {
          return yield* new OpencodeGoKeyRejectedError({ status });
        }

        if (status !== 200)
          return yield* new OpencodeGoUnavailableError({ reason: `HTTP ${status}` });
      }),
      models: Effect.forEach(
        [...providers.values()],
        (provider) =>
          Effect.flatMap(
            keyOf(provider),
            Option.match({
              onNone: () => Effect.succeed([]),
              onSome: (apiKey) => modelsOf(provider, apiKey),
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((lists) => lists.flat())),
      route: (model) => {
        const slash = model.indexOf("/");
        const provider = providers.get(model.slice(0, slash));

        return slash > 0 && provider !== undefined
          ? Option.some({
              provider: provider.name,
              model: model.slice(slash + 1),
              pooled: provider.apiKey === undefined,
            })
          : Option.none();
      },
      send: Effect.fn("Providers.send")(function* (route, path, body, session, accountKey) {
        // `route` comes from `route`, so its provider is configured.
        const provider = providers.get(route.provider);

        if (provider === undefined) return yield* Effect.die(`unrouted provider ${route.provider}`);
        const apiKey = accountKey ?? provider.apiKey;

        // The pooled provider's routes are only ever sent with an account's key.
        if (apiKey === undefined) return yield* Effect.die(`no API key for ${route.provider}`);

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
          keyed(provider.client, apiKey).execute,
        );
      }),
    });
  });

/**
 * The OpenAI-compatible providers: those configured in config.yaml, each with its
 * API key, and opencode Go, whose keys are the accounts via stores.
 */
export class Providers extends Context.Service<
  Providers,
  {
    /** Every provider with its own API key, in config.yaml's order. */
    readonly names: ReadonlyArray<string>;
    /** The provider a `<provider>/<model>` id names, if it is configured or pooled. */
    readonly route: (model: string) => Option.Option<Route>;
    /**
     * Every provider's models as it describes them, with `<provider>/<model>`
     * ids; a provider that can't list them, or has no key to ask with, is left out.
     */
    readonly models: Effect.Effect<ReadonlyArray<{ provider: string; model: ProviderModel }>>;
    /** What opencode Go says the account with `apiKey` has used, or why it can't. */
    readonly usage: (apiKey: Redacted.Redacted<string>) => Effect.Effect<ProviderUsage>;
    /**
     * Checks `apiKey` with opencode Go before it is stored, by asking for its
     * usage: fails when opencode Go refuses it, or can't be asked.
     */
    readonly verify: (
      apiKey: Redacted.Redacted<string>,
    ) => Effect.Effect<void, OpencodeGoKeyRejectedError | OpencodeGoUnavailableError>;
    /**
     * Posts `body` to the route's provider, with its model in place of via's and
     * `session` where the provider looks for it. A pooled route is sent with
     * `apiKey`, the key of the account serving it.
     */
    readonly send: (
      route: Route,
      path: ProviderPath,
      body: Schema.JsonObject,
      session: string,
      apiKey?: Redacted.Redacted<string>,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
  }
>()("via/Providers") {
  /**
   * Sends each configured provider's requests with its key in `apiKeys`, by
   * provider name, and says it is `via/<version>`. A provider without a key fails
   * naming the environment variable its config reads the key from; opencode Go
   * needs none, as its keys are the stored accounts.
   */
  static readonly layer = (options: {
    readonly providers: Record<string, ProviderConfig>;
    readonly apiKeys: Readonly<Record<string, Redacted.Redacted<string>>>;
    readonly version: string;
  }) => Layer.effect(Providers, make(options.providers, options.apiKeys, options.version));
}
