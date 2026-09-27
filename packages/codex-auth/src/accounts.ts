import { CorruptFileError, writeJsonFile } from "@via/config";
import { Context, DateTime, Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import { decodeIdToken } from "./claims.ts";
import type { Tokens } from "./codex-auth.ts";

const Account = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  email: Schema.String,
  plan: Schema.String,
  accountId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  idToken: Schema.String,
  expiresAt: Schema.Finite,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
});
export type Account = typeof Account.Type;

export class AccountNotFoundError extends Schema.TaggedError<AccountNotFoundError>()(
  "AccountNotFoundError",
  { query: Schema.String },
) {
  override get message() {
    return `No account with id, label or email "${this.query}"`;
  }
}

const decodeAccount = Schema.decodeEffect(Schema.fromJsonString(Account));

const make = (authDir: string) => {
  const fileOf = (id: string) => `${authDir}/${id}.json`;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Changes read an account, then write it whole, one at a time: otherwise a label
    // change during a token refresh could write back the old, already-rotated tokens.
    const lock = yield* Semaphore.make(1);
    const serialized = Semaphore.withPermit(lock);

    const readAccount = (path: string) =>
      fs.readFileString(path).pipe(
        Effect.flatMap(decodeAccount),
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(new CorruptFileError({ path, reason: error.message })),
        ),
      );

    const list = Effect.gen(function* () {
      const files = yield* fs
        .readDirectory(authDir)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
      const accounts = yield* Effect.forEach(
        files.filter((name) => name.endsWith(".json")),
        (name) => readAccount(`${authDir}/${name}`),
        { concurrency: "unbounded" },
      );
      return accounts.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    }).pipe(Effect.withSpan("AccountStore.list"));

    const write = (account: Account) =>
      writeJsonFile(fileOf(account.id), Account, account).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

    const find = Effect.fn("AccountStore.find")(function* (query: string) {
      const match = (yield* list).find(
        (a) => a.id === query || a.label === query || a.email === query,
      );
      return match ?? (yield* new AccountNotFoundError({ query }));
    });

    /** Stores the tokens of a login, replacing those of the same ChatGPT account and user. */
    const save = Effect.fn("AccountStore.save")(function* (tokens: Tokens) {
      const identity = yield* decodeIdToken(tokens.idToken);
      const existing = (yield* list).find(
        (a) => a.accountId === identity.accountId && a.email === identity.email,
      );
      const account: Account = {
        id: existing?.id ?? crypto.randomUUID().slice(0, 8),
        label: existing?.label ?? identity.email,
        enabled: existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? DateTime.formatIso(yield* DateTime.now),
        ...identity,
        ...tokens,
      };
      yield* write(account);
      return account;
    }, serialized);

    const setLabel = Effect.fn("AccountStore.setLabel")(function* (query: string, label: string) {
      yield* write({ ...(yield* find(query)), label });
    }, serialized);

    const setEnabled = Effect.fn("AccountStore.setEnabled")(function* (
      query: string,
      enabled: boolean,
    ) {
      yield* write({ ...(yield* find(query)), enabled });
    }, serialized);

    const remove = Effect.fn("AccountStore.remove")(function* (query: string) {
      yield* fs.remove(fileOf((yield* find(query)).id));
    }, serialized);

    return { list, find, save, setLabel, setEnabled, remove };
  });
};

/** Logged-in Codex accounts, one owner-only JSON file per account under `authDir`. */
export class AccountStore extends Context.Service<
  AccountStore,
  Effect.Success<ReturnType<typeof make>>
>()("via/AccountStore") {
  static readonly layer = (authDir: string) => Layer.effect(AccountStore, make(authDir));
}
