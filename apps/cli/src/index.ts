#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { AccountStore, CodexAuth } from "@via/codex-auth";
import { resolvePaths } from "@via/config";
import { KeyStore } from "@via/keys";
import { Console, Effect, Layer, Option, Schema } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { accounts } from "./accounts.ts";
import { keys } from "./keys.ts";
import { serve } from "./serve.ts";
import { version } from "./version.ts";

const paths = resolvePaths();

// Points serve and accounts status at a fake Codex backend in tests.
const codexBaseUrl = process.env.VIA_CODEX_BASE_URL;

const Described = Schema.Struct({ message: Schema.String });

/** A defect's message when it has one, else the defect itself as text. */
const defectMessage = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(Described)(cause), {
    onNone: () => String(cause),
    onSome: ({ message }) => message,
  });

const via = Command.make("via").pipe(
  Command.withDescription("Pool Codex subscriptions behind one OpenAI-compatible endpoint"),
  Command.withSubcommands([
    accounts(paths.config, codexBaseUrl),
    keys,
    serve(paths.config, paths.state, codexBaseUrl),
  ]),
);

Command.runWith(via, { version })(process.argv.slice(2)).pipe(
  Effect.provide(
    Layer.mergeAll(
      KeyStore.layer(paths.keys),
      AccountStore.layer(paths.authDir),
      // VIA_CODEX_ISSUER points logins at a fake issuer in tests.
      CodexAuth.layer(process.env.VIA_CODEX_ISSUER),
    ).pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  ),
  // CLI boundary: a failure becomes one line on stderr and exit code 1, not a logged stack
  // trace. Parse errors are skipped because the CLI has already rendered them with help.
  Effect.tapError((error) =>
    CliError.isCliError(error) ? Effect.void : Console.error(`error: ${error.message}`),
  ),
  // A defect, such as Bun failing to listen on a port in use, gets the same one line.
  Effect.tapDefect((defect) => Console.error(`error: ${defectMessage(defect)}`)),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
