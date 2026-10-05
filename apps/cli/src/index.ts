#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { AccountStore, CodexAuth } from "@via/codex-auth";
import { resolvePaths } from "@via/config";
import { FallbackRuleStore } from "@via/fallbacks";
import { KeyStore } from "@via/keys";
import { OllamaAddress, OpencodeGoAccounts, OpenrouterSettings } from "@via/providers";
import { ui } from "@via/web/embedded";
import { Config, Console, Effect, Layer, Option, Schema } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { homedir } from "node:os";
import { accounts } from "./accounts.ts";
import { fallbacks } from "./fallbacks.ts";
import { keys } from "./keys.ts";
import { providers } from "./providers.ts";
import { serve } from "./serve.ts";
import { version } from "./version.ts";

/** Everything via reads from its environment, read here and nowhere else. */
const Environment = Config.all({
  home: Config.option(Config.String("VIA_HOME")),
  // Points serve and accounts status at a fake Codex backend in tests.
  codexBaseUrl: Config.option(Config.String("VIA_CODEX_BASE_URL")),
  // Points logins at a fake issuer in tests.
  codexIssuer: Config.option(Config.String("VIA_CODEX_ISSUER")),
  // Its length is checked only when `via serve` starts, so other commands run whatever it is.
  adminKey: Config.option(Config.Redacted("VIA_ADMIN_KEY")),
});

const Described = Schema.Struct({ message: Schema.String });

/** A defect's message when it has one, else the defect itself as text. */
const defectMessage = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(Described)(cause), {
    onNone: () => String(cause),
    onSome: ({ message }) => message,
  });

const main = Effect.gen(function* () {
  const env = yield* Environment;
  const paths = resolvePaths({ VIA_HOME: Option.getOrUndefined(env.home) }, homedir());
  const codexBaseUrl = Option.getOrUndefined(env.codexBaseUrl);

  const via = Command.make("via").pipe(
    Command.withDescription(
      "One OpenAI-compatible endpoint for your ChatGPT subscriptions, OpenCode Go keys and other providers",
    ),
    Command.withSubcommands([
      accounts(paths.config, codexBaseUrl),
      keys,
      providers(paths.config),
      fallbacks,
      serve({
        configPath: paths.config,
        statePath: paths.state,
        usageDbPath: paths.usageDb,
        upstreamBaseUrl: codexBaseUrl,
        adminKey: Option.getOrUndefined(env.adminKey),
        ui,
      }),
    ]),
  );

  return yield* Command.runWith(via, { version })(process.argv.slice(2)).pipe(
    Effect.provide(
      Layer.mergeAll(
        KeyStore.layer(paths.keys),
        AccountStore.layer(paths.authDir),
        OpencodeGoAccounts.layer(paths.opencodeGo),
        // The Ollama the web UI saved: `via serve` sends to it, `via accounts` lists it.
        OllamaAddress.layer(paths.ollama),
        // The OpenRouter key and models the web UI saved.
        OpenrouterSettings.layer(paths.openrouter),
        // The models a request falls back to when its own can't serve.
        FallbackRuleStore.layer(paths.fallbacks),
        CodexAuth.layer(Option.getOrUndefined(env.codexIssuer)),
      ).pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
    ),
  );
});

main.pipe(
  // CLI boundary: a failure becomes one line on stderr and exit code 1, not a logged stack
  // trace. Parse errors are skipped because the CLI has already rendered them with help.
  Effect.tapError((error) =>
    CliError.isCliError(error) ? Effect.void : Console.error(`error: ${error.message}`),
  ),
  // A defect, such as Bun failing to listen on a port in use, gets the same one line.
  Effect.tapDefect((defect) => Console.error(`error: ${defectMessage(defect)}`)),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
