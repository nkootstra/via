import { KeyStore } from "@via/keys";
import { Clock, Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { localTime, timeAgo } from "./time.ts";

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

    const now = yield* Clock.currentTimeMillis;
    // Names vary in length; padding them lines up the columns after them.
    const width = Math.max(...stored.map((k) => k.name.length));

    for (const { id, name, createdAt, lastUsedAt } of stored) {
      const used =
        lastUsedAt === null ? "never used" : `last used ${timeAgo(new Date(lastUsedAt), now)}`;

      yield* Console.log(
        `${id}  ${name.padEnd(width)}  created ${localTime(new Date(createdAt))}  ${used}`,
      );
    }
  }),
).pipe(Command.withDescription("List API keys"));

const revoke = Command.make("revoke", { idOrName: Argument.String("id-or-name") }, ({ idOrName }) =>
  Effect.gen(function* () {
    yield* (yield* KeyStore).revoke(idOrName);
    yield* Console.log(`Revoked "${idOrName}".`);
  }),
).pipe(Command.withDescription("Revoke an API key by id or name"));

const rename = Command.make(
  "rename",
  { idOrName: Argument.String("id-or-name"), name: Argument.String("new-name") },
  ({ idOrName, name }) =>
    Effect.gen(function* () {
      yield* (yield* KeyStore).rename(idOrName, name);
      yield* Console.log(`Renamed "${idOrName}" to "${name}".`);
    }),
).pipe(Command.withDescription("Rename an API key by id or name; the key itself is unchanged"));

/** `via keys`. */
export const keys = Command.make("keys").pipe(
  Command.withDescription("Manage API keys"),
  Command.withSubcommands([create, list, rename, revoke]),
);
