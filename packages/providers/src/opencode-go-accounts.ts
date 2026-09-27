import { readJsonFile, withFileLock, writeJsonFile } from "@via/config";
import { Context, DateTime, Effect, FileSystem, Layer, Redacted, Schema, Semaphore } from "effect";

/** An opencode Go API key via pools, as it stores it. */
const OpencodeGoAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  apiKey: Schema.RedactedFromValue(Schema.String),
  enabled: Schema.Boolean,
  createdAt: Schema.String,
});

type OpencodeGoAccount = typeof OpencodeGoAccount.Type;

const StoredAccounts = Schema.Array(OpencodeGoAccount);

/** An API key as via shows it: its last four characters, never the whole key. */
export const maskKey = (apiKey: Redacted.Redacted<string>) =>
  `…${Redacted.value(apiKey).slice(-4)}`;

export class OpencodeGoAccountNotFoundError extends Schema.TaggedError<OpencodeGoAccountNotFoundError>()(
  "OpencodeGoAccountNotFoundError",
  { query: Schema.String },
) {
  override get message() {
    return `No opencode Go account with id or label "${this.query}"`;
  }
}

export class DuplicateOpencodeGoKeyError extends Schema.TaggedError<DuplicateOpencodeGoKeyError>()(
  "DuplicateOpencodeGoKeyError",
  { label: Schema.String },
) {
  override get message() {
    return `That opencode Go key is already stored, as "${this.label}"`;
  }
}

const make = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Changes read the file, then write it whole: run them one at a time, or concurrent
    // changes overwrite each other. The semaphore orders this process's changes; the file
    // lock orders them against another process's (`via accounts` next to `via serve`).
    const permit = Semaphore.withPermit(yield* Semaphore.make(1));

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit(withFileLock(path, effect).pipe(Effect.provideService(FileSystem.FileSystem, fs)));

    const list = readJsonFile(path, StoredAccounts, () => []).pipe(
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
        label: label ?? `opencode Go ${maskKey(apiKey)}`,
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

    return { list, find, add, setLabel, setEnabled, remove };
  });

/**
 * The opencode Go API keys via pools, in one owner-only JSON file at `path`, in
 * the order they were added.
 */
export class OpencodeGoAccounts extends Context.Service<
  OpencodeGoAccounts,
  Effect.Success<ReturnType<typeof make>>
>()("via/OpencodeGoAccounts") {
  static readonly layer = (path: string) => Layer.effect(OpencodeGoAccounts, make(path));
}
