import { readJsonFile, withFileLock, writeJsonFile } from "@via/config";
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Redacted,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { DuplicateOpencodeGoKeyError, OpencodeGoAccountNotFoundError } from "./errors.ts";

/** An OpenCode Go API key via pools, as it stores it. */
const OpencodeGoAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  apiKey: Schema.RedactedFromValue(Schema.String),
  enabled: Schema.Boolean,
  createdAt: Schema.String,
});

export type OpencodeGoAccount = typeof OpencodeGoAccount.Type;

const StoredAccounts = Schema.Array(OpencodeGoAccount);

/** The label of the account made from the key in OpenCode Go's deprecated environment variable. */
const IMPORTED = "OpenCode Go (imported)";

/** An API key as via shows it: its last four characters, never the whole key. */
export const maskKey = (apiKey: Redacted.Redacted<string>) =>
  `…${Redacted.value(apiKey).slice(-4)}`;

/** The label of an account added without one: its key's last four characters. */
const defaultLabel = (apiKey: Redacted.Redacted<string>) => `OpenCode Go ${maskKey(apiKey)}`;

/**
 * `account`, with a label via gave it under OpenCode Go's old spelling ("opencode Go")
 * respelled; a label the user chose is theirs, and kept.
 */
const respelled = (account: OpencodeGoAccount): OpencodeGoAccount =>
  account.label === "opencode Go (imported)"
    ? { ...account, label: IMPORTED }
    : account.label === `opencode Go ${maskKey(account.apiKey)}`
      ? { ...account, label: defaultLabel(account.apiKey) }
      : account;

const make = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Changes read the file, then write it whole: run them one at a time, or concurrent
    // changes overwrite each other. The semaphore orders this process's changes; the file
    // lock orders them against another process's (`via accounts` next to `via serve`).
    const permit = Semaphore.withPermit(yield* Semaphore.make(1));
    // Counts this process's changes, so `changes` can signal each one.
    const revision = yield* SubscriptionRef.make(0);

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit(
        withFileLock(path, effect).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      ).pipe(Effect.tap(() => SubscriptionRef.update(revision, (n) => n + 1)));

    // Old labels are respelled as they are read, so the next change writes them back.
    const list = readJsonFile(path, StoredAccounts, () => []).pipe(
      Effect.map((accounts) => accounts.map(respelled)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.withSpan("OpencodeGoAccounts.list"),
    );

    const write = (accounts: ReadonlyArray<OpencodeGoAccount>) =>
      writeJsonFile(path, StoredAccounts, accounts).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

    const find = Effect.fn("OpencodeGoAccounts.find")(function* (query: string) {
      const all = yield* list;

      // An id is checked first, so a label that looks like another account's id can't hide it.
      const match = all.find((a) => a.id === query) ?? all.find((a) => a.label === query);

      return match ?? (yield* new OpencodeGoAccountNotFoundError({ query }));
    });

    /** Rewrites the account `query` names as `change` makes it. */
    const update = (query: string, change: (account: OpencodeGoAccount) => OpencodeGoAccount) =>
      Effect.gen(function* () {
        const target = yield* find(query);

        yield* write((yield* list).map((a) => (a.id === target.id ? change(a) : a)));
      });

    /** Stores `apiKey` as a new, enabled account, labelled by its last four characters unless given `label`. */
    const add = Effect.fn("OpencodeGoAccounts.add")(function* (
      apiKey: Redacted.Redacted<string>,
      label?: string,
    ) {
      const all = yield* list;
      const existing = all.find((a) => Redacted.value(a.apiKey) === Redacted.value(apiKey));

      if (existing !== undefined) {
        return yield* new DuplicateOpencodeGoKeyError({ label: existing.label });
      }

      const account: OpencodeGoAccount = {
        id: crypto.randomUUID().slice(0, 8),
        label: label ?? defaultLabel(apiKey),
        apiKey,
        enabled: true,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };

      yield* write([...all, account]);

      return account;
    }, serialized);

    const setLabel = Effect.fn("OpencodeGoAccounts.setLabel")(function* (
      query: string,
      label: string,
    ) {
      yield* update(query, (account) => ({ ...account, label }));
    }, serialized);

    const setEnabled = Effect.fn("OpencodeGoAccounts.setEnabled")(function* (
      query: string,
      enabled: boolean,
    ) {
      yield* update(query, (account) => ({ ...account, enabled }));
    }, serialized);

    const remove = Effect.fn("OpencodeGoAccounts.remove")(function* (query: string) {
      const target = yield* find(query);

      yield* write((yield* list).filter((a) => a.id !== target.id));
    }, serialized);

    /**
     * Stores `apiKey`, read from the environment, as an account labelled
     * {@link IMPORTED}, unless an account already has it; the account, if it did.
     */
    const importKey = (apiKey: Redacted.Redacted<string>) =>
      add(apiKey, IMPORTED).pipe(
        Effect.asSome,
        Effect.catchTag("DuplicateOpencodeGoKeyError", () => Effect.succeedNone),
      );

    /** Signals now, then after every change this process makes to the accounts. */
    const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

    return { list, find, add, importKey, setLabel, setEnabled, remove, changes };
  });

/**
 * The OpenCode Go API keys via pools, in one owner-only JSON file at `path`, in
 * the order they were added.
 */
export class OpencodeGoAccounts extends Context.Service<
  OpencodeGoAccounts,
  Effect.Success<ReturnType<typeof make>>
>()("via/OpencodeGoAccounts") {
  static readonly layer = (path: string) => Layer.effect(OpencodeGoAccounts, make(path));
}
