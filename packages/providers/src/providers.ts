import type { ProviderConfig } from "@via/config";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

/** Where a request goes: a configured provider and the model id it knows. */
export type Route = { provider: string; model: string };

/** The paths via forwards to an OpenAI-compatible provider. */
export type ProviderPath = "/chat/completions" | "/responses";

/** Providers via knows, so config.yaml only needs their API key. */
const PRESETS: Record<string, { baseUrl: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1" },
};

export class UnknownProviderError extends Schema.TaggedError<UnknownProviderError>()(
  "UnknownProviderError",
  { name: Schema.String },
) {
  override get message() {
    return `Provider "${this.name}" is not built in, so it needs a baseUrl`;
  }
}

type Provider = { baseUrl: string; apiKey: Redacted.Redacted };

export interface ProvidersShape {
  /** The provider a `<provider>/<model>` id names, if it is configured. */
  readonly route: (model: unknown) => Option.Option<Route>;
  /** The base URL requests to `provider` go to. */
  readonly baseUrl: (provider: string) => string | undefined;
  /** Posts `body` to the route's provider, with its model in place of via's. */
  readonly send: (
    route: Route,
    path: ProviderPath,
    body: Record<string, unknown>,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
}

const make = (configs: Record<string, ProviderConfig>) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const providers = new Map<string, Provider>();
    for (const [name, config] of Object.entries(configs)) {
      const baseUrl = config.baseUrl ?? PRESETS[name]?.baseUrl;
      if (baseUrl === undefined) return yield* new UnknownProviderError({ name });
      providers.set(name, { baseUrl, apiKey: yield* Config.Redacted(config.apiKeyEnv) });
    }

    return Providers.of({
      route: (model) => {
        if (typeof model !== "string") return Option.none();
        const slash = model.indexOf("/");
        const provider = model.slice(0, slash);
        return slash > 0 && providers.has(provider)
          ? Option.some({ provider, model: model.slice(slash + 1) })
          : Option.none();
      },
      baseUrl: (provider) => providers.get(provider)?.baseUrl,
      send: Effect.fn("Providers.send")(function* (route, path, body) {
        // `route` comes from `route`, so its provider is configured.
        const provider = providers.get(route.provider);
        if (provider === undefined) return yield* Effect.die(`unrouted provider ${route.provider}`);
        return yield* HttpClientRequest.post(`${provider.baseUrl}${path}`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(provider.apiKey)),
          HttpClientRequest.setHeader("user-agent", "via/0.0.0"),
          HttpClientRequest.bodyJsonUnsafe({ ...body, model: route.model }),
          http.execute,
        );
      }),
    });
  });

/** The OpenAI-compatible providers configured in config.yaml. */
export class Providers extends Context.Service<Providers, ProvidersShape>()("via/Providers") {
  /** Reads each provider's API key from the environment variable its config names. */
  static readonly layer = (configs: Record<string, ProviderConfig>) =>
    Layer.effect(Providers, make(configs));
}
