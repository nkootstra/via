import { BunHttpServer } from "@effect/platform-bun";
import { AccountTokens } from "@via/codex-auth";
import { loadConfig } from "@via/config";
import { ViaServer } from "@via/server";
import { Console, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { HttpServer } from "effect/unstable/http";
import { codexUpstream } from "./upstream.ts";

/**
 * `via serve`, reading `configPath`. `upstreamBaseUrl` replaces the Codex backend,
 * which only tests do.
 */
export const serve = (configPath: string, upstreamBaseUrl: string | undefined) =>
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
          Layer.provide(AccountTokens.layer),
          Layer.provide(codexUpstream(config, upstreamBaseUrl)),
        );
        return yield* HttpServer.addressFormattedWith((url) =>
          Console.log(`Listening on ${url}`),
        ).pipe(Effect.andThen(Effect.never), Effect.provide(server));
      }),
  ).pipe(Command.withDescription("Serve the OpenAI-compatible API in the foreground"));
