import type { ProviderConfig } from "@via/config";
import {
  Clock,
  Context,
  Duration,
  Effect,
  identity,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  OllamaNotEditableError,
  OllamaUnreachableError,
  OpencodeGoKeyRejectedError,
  OpencodeGoUnavailableError,
  OpenrouterKeyRejectedError,
  OpenrouterNotEditableError,
  OpenrouterNotSetUpError,
  OpenrouterUnavailableError,
} from "./errors.ts";
import { OllamaAddress, parseOllamaAddress } from "./ollama-address.ts";
import { maskKey, OpencodeGoAccounts } from "./opencode-go-accounts.ts";
import { type OpenrouterSaved, OpenrouterSettings } from "./openrouter-settings.ts";
import { budgetOf } from "./openrouter-budget.ts";
import type { OpenrouterBudget, ProviderUsage } from "./schemas.ts";

/**
 * Where a request goes: a provider and the model id it knows. A `pooled`
 * provider, OpenCode Go, is sent each request with one of its accounts' keys.
 */
export type Route = {
  provider: string;
  model: string;
  pooled: boolean;
  /** A model of OpenRouter's the web UI hasn't enabled: via refuses it rather than send it. */
  disabled?: true;
};

/**
 * The paths via forwards to an OpenAI-compatible provider, Anthropic's
 * Messages, which OpenCode Go serves some of its models in, and Ollama's
 * System One.
 */
export type ProviderPath = "/chat/completions" | "/responses" | "/messages" | "/systemone";

/** The Messages API version via speaks. */
const ANTHROPIC_VERSION = "2023-06-01";

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
  /** It takes no API key, as a model server on your own machine doesn't. */
  keyless?: true;
};

/** The pooled provider: OpenCode Go, whose API keys via stores as accounts. */
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
  // https://docs.ollama.com/openai: on this machine by default; `baseUrl` points elsewhere.
  ["ollama", { baseUrl: "http://localhost:11434/v1", session: undefined, keyless: true }],
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
    return this.variable === ""
      ? `Provider "${this.provider}" needs an API key: set apiKeyEnv to the environment variable that holds it`
      : `Provider "${this.provider}" reads its API key from ${this.variable}, which is not set`;
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

/** How long a provider may take over its models, usage or a key check, which it answers at once. */
const LOOKUP_TIMEOUT = Duration.seconds(30);

/**
 * How long a provider may take to start answering a request. A request that
 * doesn't stream is answered only once the model is done, so this is long;
 * a stream, once started, lasts as long as the model takes.
 */
const RESPONSE_START_TIMEOUT = Duration.minutes(10);

/** `limit`, as a reason a request failed: it was not answered in time. */
const unansweredWithin = (limit: Duration.Duration) => `no answer within ${Duration.format(limit)}`;

/** A provider did not answer a lookup within `LOOKUP_TIMEOUT`. */
class ProviderTimeoutError extends Schema.TaggedError<ProviderTimeoutError>()(
  "ProviderTimeoutError",
  { provider: Schema.String },
) {
  override get message() {
    return `${this.provider} gave ${unansweredWithin(LOOKUP_TIMEOUT)}`;
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
  /** Its one API key; none for the pooled provider, whose accounts each have one, or a keyless one. */
  apiKey: Redacted.Redacted<string> | undefined;
  /** OpenCode Go: each request is sent with the key of the account serving it. */
  pooled: boolean;
  session: SessionTarget;
  /** The path of its usage endpoint, for a provider that reports usage. */
  usagePath: string | undefined;
};

/** `client`, sending each request with `apiKey`, or with no key for a provider that takes none. */
const keyed = (client: HttpClient.HttpClient, apiKey: Redacted.Redacted<string> | undefined) =>
  apiKey === undefined
    ? client
    : HttpClient.mapRequest(client, HttpClientRequest.bearerToken(apiKey));

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

    // A key its variable should hold, or a known provider that needs one, is missing. Any
    // other provider without a variable takes no key.
    const needsKey =
      config.apiKeyEnv !== undefined || (preset !== undefined && preset.keyless !== true);

    if (apiKey === undefined && !pooled && needsKey) {
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
      pooled,
      session:
        config.sessionHeader === undefined ? preset?.session : { header: config.sessionHeader },
      usagePath: preset?.usagePath,
    } satisfies Provider;
  });

/** The provider's models, asked with `apiKey` if it takes one, with `<provider>/<model>` ids. */
const modelsOf = ({ name, client }: Provider, apiKey: Redacted.Redacted<string> | undefined) =>
  keyed(client, apiKey)
    .get("/models")
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelList)),
      Effect.map(({ data }) =>
        data.map((model) => ({ provider: name, model: { ...model, id: `${name}/${model.id}` } })),
      ),
      Effect.timeout(LOOKUP_TIMEOUT),
      // A provider that is down, slow or answers oddly just has no models to offer now.
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
    Effect.timeoutOrElse({
      duration: LOOKUP_TIMEOUT,
      orElse: () => Effect.fail(new ProviderTimeoutError({ provider: name })),
    }),
    // Usage failing, for whatever reason, is reported rather than failing whoever asked.
    Effect.catch((error) =>
      Effect.succeed<ProviderUsage>({ provider: name, error: error.message }),
    ),
  );

/** The provider an OpenRouter key added in the web UI goes by. */
const OPENROUTER = "openrouter";

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

/** A price per token, as OpenRouter writes it, per million tokens; none when it gives none. */
const perMillion = (perToken: string | undefined) => {
  const value = Number(perToken);

  return perToken === undefined || !Number.isFinite(value) ? null : value * 1_000_000;
};

/** The unavailable error for `reason`. */
const openrouterDown = (reason: string) => new OpenrouterUnavailableError({ reason });

/** Checks `apiKey` with OpenRouter, by asking what it knows of the key. */
const verifyOpenrouter = (provider: Provider, apiKey: Redacted.Redacted<string>) =>
  keyed(provider.client, apiKey)
    .get("/key")
    .pipe(
      Effect.catchTag("HttpClientError", () =>
        Effect.fail(openrouterDown("it could not be reached")),
      ),
      Effect.timeoutOrElse({
        duration: LOOKUP_TIMEOUT,
        orElse: () => Effect.fail(openrouterDown(`it gave ${unansweredWithin(LOOKUP_TIMEOUT)}`)),
      }),
      Effect.flatMap(({ status }) =>
        Effect.gen(function* () {
          if (status === 401 || status === 403) {
            return yield* new OpenrouterKeyRejectedError({ status });
          }

          if (status !== 200) return yield* openrouterDown(`HTTP ${status}`);
        }),
      ),
    );

/** What OpenRouter tells of a key: its limit, what's left of it, and how often it resets. */
const OpenrouterKeyInfo = Schema.Struct({
  data: Schema.Struct({
    limit: Schema.NullOr(Schema.Finite),
    limit_remaining: Schema.NullOr(Schema.Finite),
    limit_reset: Schema.NullOr(Schema.Literals(["daily", "weekly", "monthly"])),
  }),
});

/** The budget of `provider`'s key, as OpenRouter tells it, or why it couldn't be read. */
const budgetFrom = (provider: Provider) =>
  keyed(provider.client, provider.apiKey)
    .get("/key")
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenrouterKeyInfo)),
      Effect.timeout(LOOKUP_TIMEOUT),
      Effect.flatMap(({ data }) =>
        Effect.map(Clock.currentTimeMillis, (now) => ({ budget: budgetOf(data, now) })),
      ),
      // A budget that can't be read is reported, not a failure: the card says why.
      Effect.catchTags({
        SchemaError: () =>
          Effect.succeed({ error: "OpenRouter answered with a key budget via can't read" }),
      }),
      Effect.catch((error) =>
        Effect.succeed({ error: `OpenRouter didn't tell the key's budget: ${error.message}` }),
      ),
    );

/** Every model OpenRouter lists, to pick which via offers. */
const catalogOf = (provider: Provider) =>
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

/** The provider an Ollama added in the web UI goes by. */
const OLLAMA = "ollama";

/** Where Ollama listens unless told otherwise. */
const OLLAMA_DEFAULT = "http://localhost:11434";

const OllamaVersion = Schema.Struct({ version: Schema.String });

const unreachable = (reason: string) => new OllamaUnreachableError({ reason });

/** Asks the Ollama at `address` for `path`: nothing there, or something that isn't Ollama, says so. */
const askOllama = <S extends Schema.Codec<unknown, unknown>>(
  http: HttpClient.HttpClient,
  address: string,
  path: string,
  schema: S,
) =>
  http.get(`${address}${path}`).pipe(
    Effect.catchTag("HttpClientError", () => Effect.fail(unreachable("nothing answered there"))),
    Effect.flatMap((response) =>
      HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.mapError(() => unreachable("what answered there isn't Ollama")),
      ),
    ),
  );

/**
 * The Ollama version at `address`, from Ollama's own API, and the models its
 * OpenAI-compatible one lists: what via will send to.
 */
const checkOllama = (http: HttpClient.HttpClient, address: string) =>
  Effect.gen(function* () {
    const { version } = yield* askOllama(http, address, "/api/version", OllamaVersion);
    const { data } = yield* askOllama(http, address, "/v1/models", ModelList);

    return { version, models: data.map(({ id }) => id) };
  }).pipe(
    Effect.timeoutOrElse({
      duration: LOOKUP_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OllamaUnreachableError({ reason: `it gave ${unansweredWithin(LOOKUP_TIMEOUT)}` }),
        ),
    }),
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

    const openrouterStore = yield* Effect.serviceOption(OpenrouterSettings);
    const openrouterConfig = configs[OPENROUTER];
    // OpenRouter's key comes from the web UI unless config.yaml names the variable holding it.

    const openrouterFromUi =
      Option.isSome(openrouterStore) && openrouterConfig?.apiKeyEnv === undefined;

    for (const [name, config] of Object.entries(configs)) {
      if (name === OPENROUTER && openrouterFromUi) continue;
      providers.set(name, yield* resolve(http, version, name, config, apiKeys[name]));
    }

    /** The OpenRouter models the web UI enabled; every one, when config.yaml sets it up. */
    let enabledOpenrouter: ReadonlySet<string> | undefined = undefined;

    /** OpenRouter with `apiKey`, where config.yaml says or at its usual address. */
    const openrouterWith = (apiKey: Redacted.Redacted<string>) =>
      resolve(
        http,
        version,
        OPENROUTER,
        {
          ...(openrouterConfig?.baseUrl === undefined ? {} : { baseUrl: openrouterConfig.baseUrl }),
          ...(openrouterConfig?.sessionHeader === undefined
            ? {}
            : { sessionHeader: openrouterConfig.sessionHeader }),
        },
        apiKey,
      ).pipe(
        // OpenRouter's preset has an address, and this gives it a key: resolving it can't fail.
        Effect.orDie,
      );

    /** Sends `openrouter/…` requests with the saved key, for the models it enables. */
    const connectOpenrouter = (saved: OpenrouterSaved) =>
      Effect.map(openrouterWith(saved.apiKey), (provider) => {
        providers.set(OPENROUTER, provider);
        enabledOpenrouter = new Set(saved.models);
      });

    // The settings file is via's own; failing to use it is a defect, as with its other files.
    const savedOpenrouter = Option.match(openrouterStore, {
      onNone: () => Effect.succeedNone,
      onSome: (settings) => Effect.orDie(settings.get),
    });

    if (openrouterFromUi) {
      yield* Effect.flatMap(
        savedOpenrouter,
        Option.match({ onNone: () => Effect.void, onSome: connectOpenrouter }),
      );
    }

    const editableOpenrouter: Effect.Effect<
      OpenrouterSettings["Service"],
      OpenrouterNotEditableError
    > =
      Option.isSome(openrouterStore) && openrouterFromUi
        ? Effect.succeed(openrouterStore.value)
        : Effect.fail(new OpenrouterNotEditableError());

    /** Whether `id`, a model of `provider`'s without its prefix, is one via offers. */
    const offered = (provider: string, id: string) =>
      provider !== OPENROUTER || enabledOpenrouter === undefined || enabledOpenrouter.has(id);

    const store = yield* Effect.serviceOption(OllamaAddress);
    const configured = configs[OLLAMA];

    /** Sends `ollama/…` requests to the Ollama at `address`. */
    const connect = (address: string) =>
      resolve(http, version, OLLAMA, { baseUrl: `${address}/v1` }, undefined).pipe(
        // Ollama's preset takes no key, and this gives its address: resolving it can't fail.
        Effect.orDie,
        Effect.map((provider) => void providers.set(OLLAMA, provider)),
      );

    // The address file is via's own; failing to use it is a defect, as with its other files.
    const saved = Option.match(store, {
      onNone: () => Effect.succeedNone,
      onSome: (address) => Effect.orDie(address.get),
    });

    if (configured === undefined) {
      yield* Effect.flatMap(saved, Option.match({ onNone: () => Effect.void, onSome: connect }));
    }

    /** The store the web UI changes Ollama's address in, unless config.yaml sets it up. */
    const editable: Effect.Effect<OllamaAddress["Service"], OllamaNotEditableError> =
      Option.isSome(store) && configured === undefined
        ? Effect.succeed(store.value)
        : Effect.fail(new OllamaNotEditableError());

    // The pooled provider needs no config: its keys are the accounts via stores.
    const pooled = providers.get(POOLED) ?? (yield* resolve(http, version, POOLED, {}, undefined));
    providers.set(POOLED, pooled);

    /** The key of the pooled provider's first enabled account, for what any of them may ask. */
    const anyAccountKey = accounts.list.pipe(
      Effect.map((all) => Option.fromUndefinedOr(all.find(({ enabled }) => enabled)?.apiKey)),
      // A store via can't read has no key to lend.
      Effect.orElseSucceed(Option.none),
    );

    /** The key to ask `provider` with: its own, none for a keyless one, or an account's if pooled. */
    const keyOf = (
      provider: Provider,
    ): Effect.Effect<Option.Option<Redacted.Redacted<string> | undefined>> =>
      provider.pooled ? anyAccountKey : Effect.succeedSome(provider.apiKey);

    return Providers.of({
      names: Effect.sync(() =>
        [...providers.values()].flatMap(({ name, pooled: isPooled }) => (isPooled ? [] : [name])),
      ),
      local: Effect.sync(() =>
        [...providers.values()].flatMap(({ name, pooled: isPooled, apiKey }) =>
          isPooled || apiKey !== undefined ? [] : [name],
        ),
      ),
      ollama: {
        get:
          configured === undefined
            ? Effect.map(
                saved,
                Option.map((address) => ({ address, fromConfig: false })),
              )
            : Effect.succeedSome({
                address: Option.getOrElse(
                  parseOllamaAddress(configured.baseUrl ?? OLLAMA_DEFAULT),
                  () => configured.baseUrl ?? OLLAMA_DEFAULT,
                ),
                fromConfig: true,
              }),
        // The routes change before the store, whose change signals the admin state: a
        // state made on that signal then has the routes it names.
        set: (address) =>
          editable.pipe(
            Effect.tap(() => connect(address)),
            Effect.flatMap((store_) => Effect.orDie(store_.set(address))),
          ),
        remove: editable.pipe(
          Effect.tap(() => Effect.sync(() => void providers.delete(OLLAMA))),
          Effect.flatMap((store_) => Effect.orDie(store_.remove)),
        ),
        check: (address) => checkOllama(http, address),
        changes: Option.match(store, {
          onNone: () => Stream.make(undefined),
          onSome: (address) => address.changes,
        }),
      },
      usage: (apiKey) => usageOf(pooled, pooled.usagePath ?? "/usage", apiKey),
      verify: Effect.fn("Providers.verify")(function* (apiKey) {
        const { status } = yield* keyed(pooled.client, apiKey)
          .get(pooled.usagePath ?? "/usage")
          .pipe(
            Effect.catchTag("HttpClientError", () =>
              Effect.fail(new OpencodeGoUnavailableError({ reason: "it could not be reached" })),
            ),
            Effect.timeoutOrElse({
              duration: LOOKUP_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new OpencodeGoUnavailableError({
                    reason: `it gave ${unansweredWithin(LOOKUP_TIMEOUT)}`,
                  }),
                ),
            }),
          );

        if (status === 401 || status === 403) {
          return yield* new OpencodeGoKeyRejectedError({ status });
        }

        if (status !== 200)
          return yield* new OpencodeGoUnavailableError({ reason: `HTTP ${status}` });
      }),
      // Read when asked: an Ollama may have been added or removed since.
      models: Effect.suspend(() =>
        Effect.forEach(
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
        ),
      ).pipe(
        Effect.map((lists) =>
          lists
            .flat()
            .filter(({ provider, model }) =>
              offered(provider, model.id.slice(provider.length + 1)),
            ),
        ),
      ),
      route: (model) => {
        const slash = model.indexOf("/");
        const provider = providers.get(model.slice(0, slash));

        if (slash <= 0 || provider === undefined) return Option.none();
        const id = model.slice(slash + 1);

        return Option.some({
          provider: provider.name,
          model: id,
          pooled: provider.pooled,
          ...(offered(provider.name, id) ? {} : { disabled: true as const }),
        });
      },
      openrouter: {
        get: openrouterFromUi
          ? Effect.map(
              savedOpenrouter,
              Option.map(({ apiKey, models }) => ({
                key: maskKey(apiKey),
                models,
                fromConfig: false,
              })),
            )
          : Effect.succeed(
              Option.map(Option.fromUndefinedOr(apiKeys[OPENROUTER]), (apiKey) => ({
                key: maskKey(apiKey),
                models: [],
                fromConfig: true,
              })),
            ),
        setKey: (apiKey) =>
          Effect.gen(function* () {
            const settings = yield* editableOpenrouter;
            yield* verifyOpenrouter(yield* openrouterWith(apiKey), apiKey);

            // A new key keeps the models the old one enabled.
            const models = Option.match(yield* savedOpenrouter, {
              onNone: (): ReadonlyArray<string> => [],
              onSome: (before) => before.models,
            });

            const next = { apiKey, models };
            // The routes change before the file, whose change signals the admin state.
            yield* connectOpenrouter(next);
            yield* Effect.orDie(settings.set(next));
          }),
        setModels: (models) =>
          Effect.gen(function* () {
            const settings = yield* editableOpenrouter;
            const current = yield* savedOpenrouter;

            if (Option.isNone(current)) return yield* new OpenrouterNotSetUpError();
            const next = { apiKey: current.value.apiKey, models };
            yield* connectOpenrouter(next);
            yield* Effect.orDie(settings.set(next));
          }),
        remove: Effect.gen(function* () {
          const settings = yield* editableOpenrouter;
          providers.delete(OPENROUTER);
          enabledOpenrouter = undefined;
          yield* Effect.orDie(settings.remove);
        }),
        catalog: Effect.gen(function* () {
          const provider = providers.get(OPENROUTER);

          if (provider === undefined) return yield* new OpenrouterNotSetUpError();

          return yield* catalogOf(provider);
        }),
        budget: Effect.suspend(() => {
          const provider = providers.get(OPENROUTER);

          return provider === undefined ? Effect.succeedNone : Effect.asSome(budgetFrom(provider));
        }),
        changes: Option.match(openrouterStore, {
          onNone: () => Stream.make(undefined),
          onSome: (settings) => settings.changes,
        }),
      },
      send: Effect.fn("Providers.send")(function* (route, path, body, session, accountKey) {
        // `route` comes from `route`, so its provider is configured.
        const provider = providers.get(route.provider);

        if (provider === undefined) return yield* Effect.die(`unrouted provider ${route.provider}`);
        const apiKey = accountKey ?? provider.apiKey;

        // The pooled provider's routes are only ever sent with an account's key.
        if (apiKey === undefined && provider.pooled) {
          return yield* Effect.die(`no API key for ${route.provider}`);
        }

        const request = HttpClientRequest.post(path).pipe(
          // Anthropic's SDK sends the key as `x-api-key`, and names the version it speaks.
          path === "/messages" && apiKey !== undefined
            ? HttpClientRequest.setHeaders({
                "x-api-key": Redacted.value(apiKey),
                "anthropic-version": ANTHROPIC_VERSION,
              })
            : identity,
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
        );

        // A provider that never starts answering is as good as unreachable.
        return yield* keyed(provider.client, apiKey)
          .execute(request)
          .pipe(
            Effect.timeoutOrElse({
              duration: RESPONSE_START_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: unansweredWithin(RESPONSE_START_TIMEOUT),
                    }),
                  }),
                ),
            }),
          );
      }),
    });
  });

/**
 * The OpenAI-compatible providers: those configured in config.yaml, each with its
 * API key, and OpenCode Go, whose keys are the accounts via stores.
 */
export class Providers extends Context.Service<
  Providers,
  {
    /** Every provider with its own API key, in config.yaml's order, then an Ollama added later. */
    readonly names: Effect.Effect<ReadonlyArray<string>>;
    /** Every provider sent no key, such as Ollama, taken to run on your own hardware. */
    readonly local: Effect.Effect<ReadonlyArray<string>>;
    /**
     * Ollama, as config.yaml sets it up or the web UI saved it: where it is,
     * changed at once. One in config.yaml can't be changed here.
     */
    readonly ollama: {
      readonly get: Effect.Effect<
        Option.Option<{ readonly address: string; readonly fromConfig: boolean }>
      >;
      readonly set: (address: string) => Effect.Effect<void, OllamaNotEditableError>;
      readonly remove: Effect.Effect<void, OllamaNotEditableError>;
      /** The Ollama version at `address` and the models it has, or why it can't be used. */
      readonly check: (
        address: string,
      ) => Effect.Effect<
        { readonly version: string; readonly models: ReadonlyArray<string> },
        OllamaUnreachableError
      >;
      /** Signals now, then after each change to the saved address. */
      readonly changes: Stream.Stream<void>;
    };
    /**
     * OpenRouter, with the key the web UI saved and the models it enables, or
     * the key config.yaml names, with every model. One in config.yaml can't be
     * changed here.
     */
    readonly openrouter: {
      readonly get: Effect.Effect<
        Option.Option<{
          readonly key: string;
          readonly models: ReadonlyArray<string>;
          readonly fromConfig: boolean;
        }>
      >;
      /** Saves `apiKey` once OpenRouter accepts it, keeping the models enabled before. */
      readonly setKey: (
        apiKey: Redacted.Redacted<string>,
      ) => Effect.Effect<
        void,
        OpenrouterNotEditableError | OpenrouterKeyRejectedError | OpenrouterUnavailableError
      >;
      /** Offers exactly `models` of OpenRouter's, by their ids without `openrouter/`. */
      readonly setModels: (
        models: ReadonlyArray<string>,
      ) => Effect.Effect<void, OpenrouterNotEditableError | OpenrouterNotSetUpError>;
      readonly remove: Effect.Effect<void, OpenrouterNotEditableError>;
      /** Every model OpenRouter lists, with its prices per million tokens. */
      readonly catalog: Effect.Effect<
        ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly inputPerMillion: number | null;
          readonly outputPerMillion: number | null;
          readonly contextLength: number | null;
        }>,
        OpenrouterNotSetUpError | OpenrouterUnavailableError
      >;
      /**
       * The key's budget as OpenRouter tells it: none without a key, null for a
       * key without a limit, or why it couldn't be read. It never fails.
       */
      readonly budget: Effect.Effect<
        Option.Option<{ readonly budget: OpenrouterBudget | null } | { readonly error: string }>
      >;
      /** Signals now, then after each change to the saved key or models. */
      readonly changes: Stream.Stream<void>;
    };
    /** The provider a `<provider>/<model>` id names, if it is configured or pooled. */
    readonly route: (model: string) => Option.Option<Route>;
    /**
     * Every provider's models as it describes them, with `<provider>/<model>`
     * ids; a provider that can't list them, or has no key to ask with, is left out.
     */
    readonly models: Effect.Effect<ReadonlyArray<{ provider: string; model: ProviderModel }>>;
    /** What OpenCode Go says the account with `apiKey` has used, or why it can't. */
    readonly usage: (apiKey: Redacted.Redacted<string>) => Effect.Effect<ProviderUsage>;
    /**
     * Checks `apiKey` with OpenCode Go before it is stored, by asking for its
     * usage: fails when OpenCode Go refuses it, or can't be asked.
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
   * naming the environment variable its config reads the key from; OpenCode Go
   * needs none, as its keys are the stored accounts.
   */
  static readonly layer = (options: {
    readonly providers: Record<string, ProviderConfig>;
    readonly apiKeys: Readonly<Record<string, Redacted.Redacted<string>>>;
    readonly version: string;
  }) => Layer.effect(Providers, make(options.providers, options.apiKeys, options.version));
}
