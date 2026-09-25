import { BunHttpServer } from "@effect/platform-bun";
import { AccountTokens } from "@via/codex-auth";
import { loadConfig } from "@via/config";
import { PoolStates } from "@via/pool";
import { Providers } from "@via/providers";
import { ViaServer } from "@via/server";
import { ConfigProvider, Console, Effect, Layer, Logger, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { HttpServer } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { codexUpstream } from "./upstream.ts";

/**
 * Exports spans over OTLP/HTTP when the standard `OTEL_EXPORTER_OTLP_ENDPOINT`
 * variables name a collector; without one it does nothing. Effect only exports
 * when `OTEL_TRACES_EXPORTER` says `otlp`, so that gets the spec's default.
 */
const tracing = OtlpTracer.layerFromConfig({
  resource: { serviceName: "via", serviceVersion: "0.0.0" },
}).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(
    ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ OTEL_TRACES_EXPORTER: "otlp" })),
  ),
);

/**
 * `via serve`, reading `configPath` and keeping cooldowns in `statePath`.
 * `upstreamBaseUrl` replaces the Codex backend, which only tests do.
 */
export const serve = (configPath: string, statePath: string, upstreamBaseUrl: string | undefined) =>
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
        const server = ViaServer.layer.pipe(
          Layer.provideMerge(
            BunHttpServer.layer({
              hostname: Option.getOrElse(host, () => config.host),
              port: Option.getOrElse(port, () => config.port),
            }),
          ),
          Layer.provide(PoolStates.layerFile(statePath)),
          Layer.provide(AccountTokens.layer),
          Layer.provide(codexUpstream(config, upstreamBaseUrl)),
          Layer.provide(Providers.layer(config.providers)),
          Layer.provideMerge(tracing),
          // One line per entry, as `key=value` pairs that grep and log tools read.
          Layer.provide(Logger.layer([Logger.consoleLogFmt])),
        );
        return yield* HttpServer.addressFormattedWith((url) =>
          Console.log(`Listening on ${url}`),
        ).pipe(Effect.andThen(Effect.never), Effect.provide(server));
      }),
  ).pipe(Command.withDescription("Serve the OpenAI-compatible API in the foreground"));
