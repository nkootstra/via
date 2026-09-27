import { KeyStore } from "@via/keys";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

const create = Command.make(
  "create",
  { name: Flag.String("name").pipe(Flag.withDescription("A label for the key")) },
  ({ name }) =>
    Effect.gen(function* () {
      const created = yield* (yield* KeyStore).create(name);
      yield* Console.log(`Created key "${created.name}" (${created.id}). It is shown only once:`);
      yield* Console.log(created.key);
    }),
).pipe(Command.withDescription("Create an API key for clients of `via serve`"));

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const stored = yield* (yield* KeyStore).list;

    if (stored.length === 0)
      return yield* Console.log("No keys. Create one with `via keys create --name <name>`.");

    for (const key of stored) yield* Console.log(`${key.id}  ${key.name}  ${key.createdAt}`);
  }),
).pipe(Command.withDescription("List API keys"));

const revoke = Command.make("revoke", { idOrName: Argument.String("id-or-name") }, ({ idOrName }) =>
  Effect.gen(function* () {
    yield* (yield* KeyStore).revoke(idOrName);
    yield* Console.log(`Revoked "${idOrName}".`);
  }),
).pipe(Command.withDescription("Revoke an API key by id or name"));

/** `via keys`. */
export const keys = Command.make("keys").pipe(
  Command.withDescription("Manage API keys"),
  Command.withSubcommands([create, list, revoke]),
);
