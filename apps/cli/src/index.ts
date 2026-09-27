#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { AccountStore, CodexAuth } from "@via/codex-auth";
import { resolvePaths } from "@via/config";
import { KeyStore } from "@via/keys";
import { Console, Effect, Layer, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { accounts } from "./accounts.ts";
import { serve } from "./serve.ts";
import { version } from "./version.ts";

const paths = resolvePaths();

const Described = Schema.Struct({ message: Schema.String });

/** A defect's message when it has one, else the defect itself as text. */
const defectMessage = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(Described)(cause), {
    onNone: () => String(cause),
    onSome: ({ message }) => message,
  });

const keysCreate = Command.make(
  "create",
  { name: Flag.String("name").pipe(Flag.withDescription("A label for the key")) },
  ({ name }) =>
    Effect.gen(function* () {
      const created = yield* (yield* KeyStore).create(name);
      yield* Console.log(`Created key "${created.name}" (${created.id}). It is shown only once:`);
      yield* Console.log(created.key);
    }),
).pipe(Command.withDescription("Create an API key for clients of `via serve`"));

const keysList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const keys = yield* (yield* KeyStore).list;

    if (keys.length === 0)
      return yield* Console.log("No keys. Create one with `via keys create --name <name>`.");

    for (const key of keys) yield* Console.log(`${key.id}  ${key.name}  ${key.createdAt}`);
  }),
).pipe(Command.withDescription("List API keys"));

const keysRevoke = Command.make(
  "revoke",
  { idOrName: Argument.String("id-or-name") },
  ({ idOrName }) =>
    Effect.gen(function* () {
      yield* (yield* KeyStore).revoke(idOrName);
      yield* Console.log(`Revoked "${idOrName}".`);
    }),
).pipe(Command.withDescription("Revoke an API key by id or name"));

const keys = Command.make("keys").pipe(
  Command.withDescription("Manage API keys"),
  Command.withSubcommands([keysCreate, keysList, keysRevoke]),
);

const via = Command.make("via").pipe(
  Command.withDescription("Pool Codex subscriptions behind one OpenAI-compatible endpoint"),
  // VIA_CODEX_BASE_URL points serve and accounts status at a fake Codex backend in tests.
  Command.withSubcommands([
    accounts(paths.config, process.env.VIA_CODEX_BASE_URL),
    keys,
    serve(paths.config, paths.state, process.env.VIA_CODEX_BASE_URL),
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
