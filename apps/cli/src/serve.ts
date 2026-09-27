import { BunHttpServer } from "@effect/platform-bun";
import { AccountPool, UsagePoll, UsageSnapshots } from "@via/account-pool";
import { AccountTokens } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { loadConfig } from "@via/config";
import { PoolStates } from "@via/pool";
import { OpencodeGoPool, Providers } from "@via/providers";
import { type EmbeddedUi, ViaServer } from "@via/server";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Logger,
  Option,
  type Redacted,
  References,
} from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { HttpClient, HttpServer } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { apiKeys, importOpencodeGoKey } from "./api-keys.ts";
import { version } from "./version.ts";

/**
 * Exports spans over OTLP/HTTP when the standard `OTEL_EXPORTER_OTLP_ENDPOINT`
 * variables name a collector. Effect only exports when `OTEL_TRACES_EXPORTER`
 * says `otlp`, so that gets the spec's default.
 */
const exporting = OtlpTracer.layerFromConfig({
  resource: { serviceName: "via", serviceVersion: version },
}).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(
    ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ OTEL_TRACES_EXPORTER: "otlp" })),
  ),
);

/**
 * Without a collector, spans would be built for every request and go nowhere,
 * and upstreams would still be sent `traceparent` and `b3` headers, so tracing
 * is off instead.
 */
const off = Layer.mergeAll(
  Layer.succeed(References.TracerEnabled, false),
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);

const tracing = Layer.unwrap(
  Effect.gen(function* () {
    const traces = yield* Config.option(Config.String("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"));
    const all = yield* Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"));

    return Option.isSome(traces) || Option.isSome(all) ? exporting : off;
  }),
);

/**
 * Imports opencode Go's key from its deprecated environment variable, when it is
 * set, and warns that the variable is deprecated for as long as it is.
 */
const importDeprecatedKey = (
  providers: Parameters<typeof importOpencodeGoKey>[0],
  keys: Parameters<typeof importOpencodeGoKey>[1],
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const variable = yield* importOpencodeGoKey(providers, keys);

      if (Option.isNone(variable)) return;

      yield* Effect.logWarning(
        `${variable.value} is deprecated: via keeps opencode Go keys as accounts now, and has ` +
          `imported this one. Remove ${variable.value}; add more keys with ` +
          "`via accounts add --provider opencode-go`.",
      );
    }),
  );

/** opencode Go's deprecated key variable and the key it holds, while it is set. */
const opencodeGoEnvironment = (
  config: { readonly providers: Parameters<typeof importOpencodeGoKey>[0] },
  keys: Parameters<typeof importOpencodeGoKey>[1],
) => {
  const variable = config.providers["opencode-go"]?.apiKeyEnv;
  const apiKey = keys["opencode-go"];

  return variable === undefined || apiKey === undefined ? undefined : { variable, apiKey };
};

/**
 * `via serve`, reading `configPath` and keeping cooldowns in `statePath`.
 * `upstreamBaseUrl` replaces the Codex backend, which only tests do. With
 * `adminKey`, the admin API is served behind it, and `ui`, the admin UI, at `/ui`.
 */
export const serve = ({
  configPath,
  statePath,
  upstreamBaseUrl,
  adminKey,
  ui,
}: {
  readonly configPath: string;
  readonly statePath: string;
  readonly upstreamBaseUrl: string | undefined;
  readonly adminKey: Redacted.Redacted<string> | undefined;
  readonly ui: EmbeddedUi;
}) =>
  Command.make(
    "serve",
    {
      host: Flag.String("host").pipe(
        Flag.withDescription("Address to listen on, instead of config.yaml's host"),
        Flag.optional,
      ),
      port: Flag.Int("port").pipe(
        Flag.withDescription("Port to listen on, instead of config.yaml's port"),
        Flag.optional,
      ),
    },
    ({ host, port }) =>
      Effect.gen(function* () {
        const config = yield* loadConfig(configPath);
        const keys = yield* apiKeys(config.providers);

        const server = Layer.mergeAll(
          ViaServer.layer({
            adminKey,
            ui,
            opencodeGoEnvironment: opencodeGoEnvironment(config, keys),
          }),
          UsagePoll.layer,
          importDeprecatedKey(config.providers, keys),
        ).pipe(
          Layer.provideMerge(
            BunHttpServer.layer({
              hostname: Option.getOrElse(host, () => config.host),
              port: Option.getOrElse(port, () => config.port),
            }),
          ),
          // One pool and one set of usage snapshots, shared by the API and the usage poll.
          Layer.provide(Layer.mergeAll(AccountPool.layer, OpencodeGoPool.layer)),
          Layer.provide(UsageSnapshots.layer),
          Layer.provide(PoolStates.layerFile(statePath)),
          Layer.provide(AccountTokens.layer),
          Layer.provide(
            CodexUpstream.layer({
              baseUrl: upstreamBaseUrl,
              cloak: config.codex.cloak,
              version,
            }),
          ),
          Layer.provide(
            Providers.layer({
              providers: config.providers,
              apiKeys: keys,
              version,
            }),
          ),
          Layer.provideMerge(tracing),
          // One line per entry, as `key=value` pairs that grep and log tools read.
          Layer.provide(Logger.layer([Logger.consoleLogFmt])),
        );

        return yield* HttpServer.addressFormattedWith((url) =>
          Console.log(`Listening on ${url}`),
        ).pipe(Effect.andThen(Effect.never), Effect.provide(server));
      }),
  ).pipe(Command.withDescription("Serve the OpenAI-compatible API in the foreground"));
