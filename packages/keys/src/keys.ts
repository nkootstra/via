import {
  cachedUntilChanged,
  fileStamp,
  readJsonFile,
  withFileLock,
  writeJsonFile,
} from "@via/config";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { createHash, timingSafeEqual } from "node:crypto";
import { DuplicateKeyNameError, KeyNotFoundError } from "./errors.ts";

const StoredKeys = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    createdAt: Schema.String,
    // Absent until the key is first used, and in files written before via recorded it.
    lastUsedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  }),
);

// How far a key's stored last use may lag its real one. Verifying a key is on every
// request's path, so it rewrites the file at most this often per key, not each time.
const PERSIST_EVERY = Duration.minutes(1);

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Keys are secrets, so this uses the OS CSPRNG rather than Effect's `Random`.
// 248 is the largest multiple of 62 below 256; rejecting above it avoids modulo bias.
const randomString = (length: number) =>
  Effect.sync(() => {
    let out = "";

    while (out.length < length) {
      for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
        if (byte < 248 && out.length < length) out += ALPHABET[byte % 62];
      }
    }

    return out;
  });

// A key carries about 190 random bits, so a fast, unsalted SHA-256 is enough to make the
// stored hash useless for recovering it; a password KDF would only slow down every request.
const hash = (key: string) => createHash("sha256").update(key).digest();

/** The later of two times, either of which may be unknown. */
const latest = (a: DateTime.Utc | undefined, b: DateTime.Utc | undefined) =>
  a === undefined || b === undefined
    ? Option.fromNullishOr(a ?? b)
    : Option.some(DateTime.max(a, b));

const make = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // create, rename and revoke read the file, then write it whole: run them one at a time, or
    // concurrent changes overwrite each other. The semaphore orders this process's changes;
    // the file lock orders them against another process's (`via keys` next to `via serve`).
    const permit = Semaphore.withPermit(yield* Semaphore.make(1));
    // Counts this process's writes to the file, so `changes` can signal each one.
    const revision = yield* SubscriptionRef.make(0);
    // Holds the writes of keys' last uses, which run off the request's path, for as long as
    // the store lives.
    const background = yield* Effect.scope;

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit(
        withFileLock(path, effect).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      ).pipe(Effect.tap(() => SubscriptionRef.update(revision, (n) => n + 1)));

    const read = readJsonFile(path, StoredKeys, () => []).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );

    // What `list` and `verify`, which every request runs, read: the file as last read until it
    // changes, by this process or another (`via keys revoke`, so the next request sees it).
    // Changes read the file itself, under the lock.
    const current = yield* cachedUntilChanged({
      stamp: fileStamp(path).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      revision: SubscriptionRef.get(revision),
      read,
    });

    const write = (keys: typeof StoredKeys.Type) =>
      writeJsonFile(path, StoredKeys, keys).pipe(Effect.provideService(FileSystem.FileSystem, fs));

    const create = Effect.fn("KeyStore.create")(function* (name: string) {
      const keys = yield* read;

      if (keys.some((k) => k.name === name)) return yield* new DuplicateKeyNameError({ name });
      const key = `via_${yield* randomString(32)}`;
      const id = (yield* randomString(8)).toLowerCase();
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* write([...keys, { id, name, hash: hash(key).toString("hex"), createdAt }]);

      return { id, name, key };
    }, serialized);

    // Each key's last use in this process, which is ahead of the file's by up to PERSIST_EVERY,
    // and when this process last decided to write it, which keeps concurrent uses of a key
    // from queueing up to write the same minute.
    const lastUsed = new Map<string, DateTime.Utc>();
    const persisted = new Map<string, DateTime.Utc>();

    /** A stored key as `list` shows it: no hash, and its last use in this process if later. */
    const shown = ({ id, name, createdAt, lastUsedAt }: (typeof StoredKeys.Type)[number]) => ({
      id,
      name,
      createdAt,
      lastUsedAt: latest(lastUsedAt, lastUsed.get(id)).pipe(
        Option.map(DateTime.formatIso),
        Option.getOrNull,
      ),
    });

    const list = current.pipe(Effect.map((keys) => keys.map(shown)));

    // An id match wins over a name match, so one change never takes out two keys.
    const find = (keys: typeof StoredKeys.Type, idOrName: string) =>
      Effect.fromNullishOr(
        keys.find((k) => k.id === idOrName) ?? keys.find((k) => k.name === idOrName),
      ).pipe(Effect.mapError(() => new KeyNotFoundError({ idOrName })));

    const revoke = Effect.fn("KeyStore.revoke")(function* (idOrName: string) {
      const keys = yield* read;
      const target = yield* find(keys, idOrName);
      yield* write(keys.filter((k) => k !== target));
    }, serialized);

    /** Renames a key; its secret, and so every client using it, is unchanged. */
    const rename = Effect.fn("KeyStore.rename")(function* (idOrName: string, name: string) {
      const keys = yield* read;
      const target = yield* find(keys, idOrName);

      if (keys.some((k) => k !== target && k.name === name)) {
        return yield* new DuplicateKeyNameError({ name });
      }

      const renamed = { ...target, name };
      yield* write(keys.map((k) => (k === target ? renamed : k)));

      return shown(renamed);
    }, serialized);

    // Re-reads under the lock, so a key revoked since `verify` read the file stays revoked. Runs
    // off the request's path, as waiting on the lock can take seconds. A failed write is only
    // logged: the key did verify, and the next use a minute on retries it.
    const persistLastUse = (id: string, at: DateTime.Utc) =>
      serialized(
        Effect.gen(function* () {
          const keys = yield* read;

          if (!keys.some((k) => k.id === id)) return;
          yield* write(keys.map((k) => (k.id === id ? { ...k, lastUsedAt: at } : k)));
        }),
      ).pipe(
        Effect.catch((error) => Effect.logWarning("Could not record a key's last use", error)),
      );

    const verify = Effect.fn("KeyStore.verify")(function* (key: string) {
      const candidate = hash(key);

      const match = (yield* current).find((k) =>
        timingSafeEqual(candidate, Buffer.from(k.hash, "hex")),
      );

      if (match === undefined) return Option.none();
      const now = yield* DateTime.now;
      lastUsed.set(match.id, now);

      const stale = Option.match(latest(match.lastUsedAt, persisted.get(match.id)), {
        onNone: () => true,
        onSome: (at) => Duration.isGreaterThanOrEqualTo(DateTime.distance(at, now), PERSIST_EVERY),
      });

      if (stale) {
        persisted.set(match.id, now);
        yield* Effect.forkIn(persistLastUse(match.id, now), background);
      }

      return Option.some({ id: match.id, name: match.name });
    });

    /**
     * Signals now, then after every write this process makes to the keys: a key
     * created, renamed or revoked, or a key's last use recorded, at most once a minute per key.
     */
    const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

    return { create, list, rename, revoke, verify, changes };
  });

/** API keys for clients of `via serve`; only SHA-256 hashes are stored. */
export class KeyStore extends Context.Service<KeyStore, Effect.Success<ReturnType<typeof make>>>()(
  "via/KeyStore",
) {
  static readonly layer = (path: string) => Layer.effect(KeyStore, make(path));
}
