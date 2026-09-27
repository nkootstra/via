import { CorruptFileError, withFileLock, writeJsonFile } from "@via/config";
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { decodeIdToken } from "./claims.ts";
import type { Tokens } from "./codex-auth.ts";
import { AccountNotFoundError } from "./errors.ts";

export const Account = Schema.Struct({
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

const decodeAccount = Schema.decodeEffect(Schema.fromJsonString(Account));

const make = (authDir: string) => {
  const fileOf = (id: string) => `${authDir}/${id}.json`;

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Changes read an account, then write it whole, one at a time: otherwise a label
    // change during a token refresh could write back the old, already-rotated tokens.
    // The semaphore orders this process's changes; the lock on the whole directory (a login
    // looks through every account) orders them against another process's, such as
    // `via accounts label` next to `via serve` refreshing tokens.
    const permit = Semaphore.withPermit(yield* Semaphore.make(1));
    // Counts this process's changes, so `changes` can signal each one.
    const revision = yield* SubscriptionRef.make(0);

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit(
        withFileLock(authDir, effect).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      ).pipe(Effect.tap(() => SubscriptionRef.update(revision, (n) => n + 1)));

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
      const all = yield* list;

      // An id is checked first, so a label that looks like another account's id can't hide it.
      const match =
        all.find((a) => a.id === query) ?? all.find((a) => a.label === query || a.email === query);

      return match ?? (yield* new AccountNotFoundError({ query }));
    });

    /**
     * Stores the tokens of a login, replacing those of the same ChatGPT account and user.
     * Says whether the login created the account or signed an existing one in again.
     */
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

      return { account, created: existing === undefined };
    }, serialized);

    /**
     * Stores the rotated tokens of account `id`. They're written to that account even if
     * the new ID token names another email or can't be read: its refresh token is spent.
     */
    const saveRefreshed = Effect.fn("AccountStore.saveRefreshed")(function* (
      id: string,
      tokens: Tokens,
    ) {
      const current = yield* find(id);

      const refreshed = yield* decodeIdToken(tokens.idToken).pipe(
        Effect.map((identity): Account => ({ ...current, ...identity, ...tokens })),
        Effect.catchTag("InvalidIdTokenError", () =>
          Effect.succeed<Account>({ ...current, ...tokens, idToken: current.idToken }),
        ),
      );

      yield* write(refreshed);

      return refreshed;
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

    /** Signals now, then after every change this process makes to the accounts. */
    const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

    return { list, find, save, saveRefreshed, setLabel, setEnabled, remove, changes };
  });
};

/** Logged-in Codex accounts, one owner-only JSON file per account under `authDir`. */
export class AccountStore extends Context.Service<
  AccountStore,
  Effect.Success<ReturnType<typeof make>>
>()("via/AccountStore") {
  static readonly layer = (authDir: string) => Layer.effect(AccountStore, make(authDir));
}
