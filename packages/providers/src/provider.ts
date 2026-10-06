import type { ProviderConfig } from "@via/config";
import { Duration, Effect, Redacted, Schema } from "effect";
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { ProviderUsage } from "./schemas.ts";

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

/** The Messages API version via speaks, unless the client names another. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The client's request headers a provider may act on, which via passes on:
 * Anthropic's and OpenAI's beta features, the Messages version, and the app
 * OpenRouter credits. Never its key, cookies or host: via sends its own.
 */
const PASSED_ON = new Set([
  "anthropic-beta",
  "anthropic-version",
  "openai-beta",
  "http-referer",
  "x-title",
]);

/** Those of the client's `headers` via passes on to a provider. */
export const passedOn = (headers: Headers.Headers) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => PASSED_ON.has(name)));

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
export const POOLED = "opencode-go";

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
export const LOOKUP_TIMEOUT = Duration.seconds(30);

/**
 * How long a provider may take to start answering a request. A request that
 * doesn't stream is answered only once the model is done, so this is long;
 * a stream, once started, lasts as long as the model takes.
 */
export const RESPONSE_START_TIMEOUT = Duration.minutes(10);

/** `limit`, as a reason a request failed: it was not answered in time. */
export const unansweredWithin = (limit: Duration.Duration) =>
  `no answer within ${Duration.format(limit)}`;

/** A provider did not answer a lookup within `LOOKUP_TIMEOUT`. */
class ProviderTimeoutError extends Schema.TaggedError<ProviderTimeoutError>()(
  "ProviderTimeoutError",
  { provider: Schema.String },
) {
  override get message() {
    return `${this.provider} gave ${unansweredWithin(LOOKUP_TIMEOUT)}`;
  }
}

/** A provider refused the API key via asked it with. */
export class ProviderKeyRefusedError extends Schema.TaggedError<ProviderKeyRefusedError>()(
  "ProviderKeyRefusedError",
  { provider: Schema.String, status: Schema.Finite },
) {
  override get message() {
    return `${this.provider} refused its API key (HTTP ${this.status})`;
  }
}

/** A provider could not be asked, and why. */
export class ProviderUnreachableError extends Schema.TaggedError<ProviderUnreachableError>()(
  "ProviderUnreachableError",
  { provider: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `${this.provider} isn't available: ${this.reason}`;
  }
}

/** A model as a provider describes it: an id, plus whatever else it tells. */
const Model = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Schema.JsonObject]);

export type ProviderModel = typeof Model.Type;

export const ModelList = Schema.Struct({ data: Schema.Array(Model) });

/** OpenCode Go's usage: each window by name, e.g. `rolling`, `weekly` and `monthly`. */
const UsagePayload = Schema.Struct({
  usage: Schema.Record(
    Schema.String,
    Schema.Struct({ status: Schema.String, percent: Schema.Finite, resetsAt: Schema.String }),
  ),
});

export type Provider = {
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
export const keyed = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string> | undefined,
) =>
  apiKey === undefined
    ? client
    : HttpClient.mapRequest(client, HttpClientRequest.bearerToken(apiKey));

/** The provider `name` as its config describes it, filled in from its preset. */
export const resolve = (
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
export const modelsOf = (
  { name, client }: Provider,
  apiKey: Redacted.Redacted<string> | undefined,
) =>
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
export const usageOf = (
  { name, client }: Provider,
  path: string,
  apiKey: Redacted.Redacted<string>,
) =>
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
    // Usage failing, for whatever reason, is reported rather than failing whoever asked:
    // in words, as a network or parser error's message is for logs.
    // An HTTP error with a response came from an answer, such as a page, that isn't JSON.
    Effect.catchTags({
      HttpClientError: (error) =>
        Effect.succeed<ProviderUsage>({
          provider: name,
          error:
            error.response === undefined
              ? `${name} couldn't be reached`
              : `${name}'s usage answer couldn't be read`,
        }),
      SchemaError: () =>
        Effect.succeed<ProviderUsage>({
          provider: name,
          error: `${name}'s usage answer couldn't be read`,
        }),
    }),
    Effect.catch((error) =>
      Effect.succeed<ProviderUsage>({ provider: name, error: error.message }),
    ),
  );

/**
 * Asks `provider` for `path` with its key: fails when it refuses the key, or
 * can't be asked.
 */
export const probe = (provider: Provider, path: string) => {
  const down = (reason: string) =>
    new ProviderUnreachableError({ provider: provider.name, reason });

  return keyed(provider.client, provider.apiKey)
    .get(path)
    .pipe(
      Effect.catchTag("HttpClientError", () => Effect.fail(down("it could not be reached"))),
      Effect.timeoutOrElse({
        duration: LOOKUP_TIMEOUT,
        orElse: () => Effect.fail(down(`it gave ${unansweredWithin(LOOKUP_TIMEOUT)}`)),
      }),
      Effect.flatMap(({ status }) =>
        Effect.gen(function* () {
          if (status === 401 || status === 403) {
            return yield* new ProviderKeyRefusedError({ provider: provider.name, status });
          }

          if (status !== 200) return yield* down(`it answered HTTP ${status}`);
        }),
      ),
    );
};
