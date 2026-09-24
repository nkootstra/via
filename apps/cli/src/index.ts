#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { resolvePaths } from "@via/config";
import { KeyStore } from "@via/keys";
import { Console, Effect, Layer, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";

class KeyNotFoundError extends Schema.TaggedError<KeyNotFoundError>()("KeyNotFoundError", {
  idOrName: Schema.String,
}) {
  override get message() {
    return `No key with id or name "${this.idOrName}"`;
  }
}

const paths = resolvePaths();

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
      if (!(yield* (yield* KeyStore).revoke(idOrName))) {
        return yield* new KeyNotFoundError({ idOrName });
      }
      yield* Console.log(`Revoked "${idOrName}".`);
    }),
).pipe(Command.withDescription("Revoke an API key by id or name"));

const keys = Command.make("keys").pipe(
  Command.withDescription("Manage API keys"),
  Command.withSubcommands([keysCreate, keysList, keysRevoke]),
);

const via = Command.make("via").pipe(
  Command.withDescription("Pool Codex subscriptions behind one OpenAI-compatible endpoint"),
  Command.withSubcommands([keys]),
);

Command.runWith(via, { version: "0.0.0" })(process.argv.slice(2)).pipe(
  Effect.provide(KeyStore.layer(paths.keys).pipe(Layer.provideMerge(BunServices.layer))),
  // CLI boundary: a failure becomes one line on stderr and exit code 1, not a logged stack
  // trace. Parse errors are skipped because the CLI has already rendered them with help.
  Effect.tapError((error) =>
    CliError.isCliError(error) ? Effect.void : Console.error(`error: ${error.message}`),
  ),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
