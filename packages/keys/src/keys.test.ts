import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { CorruptFileError } from "@via/config";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Queue,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";
import { Arbitrary } from "effect/unstable/arbitrary";
import { DuplicateKeyNameError, KeyNotFoundError, KeyStore } from "./index.ts";

const withKeyStore = <A, E>(
  body: (file: string) => Effect.Effect<A, E, KeyStore | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;

    return yield* body(file).pipe(Effect.provide(KeyStore.layer(file)));
  });

/** A file-system call's failure, as a real file system reports it. */
const fail = (reason: "AlreadyExists" | "NotFound", method: string, path: string) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: reason,
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
    }),
  );

/** A file system in memory, with just the calls a store makes on its key file and lock. */
const memoryFileSystem = () => {
  const files = new Map<string, string>();

  return FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    chmod: () => Effect.void,
    readFileString: (path) => {
      const text = files.get(path);

      return text === undefined ? fail("NotFound", "readFileString", path) : Effect.succeed(text);
    },
    writeFileString: (path, text, options) =>
      options?.flag === "wx" && files.has(path)
        ? fail("AlreadyExists", "writeFileString", path)
        : Effect.sync(() => {
            files.set(path, text);
          }),
    // Opened only to write a new file and flush it, as `writeJsonFile` does with its temp file.
    open: (path) =>
      Effect.sync((): FileSystem.File => {
        files.set(path, "");
        const unused = Effect.die(`the store only writes and flushes ${path}`);

        return {
          [FileSystem.FileTypeId]: FileSystem.FileTypeId,
          stat: unused,
          seek: () => unused,
          read: () => unused,
          readAlloc: () => unused,
          truncate: () => unused,
          write: () => unused,
          writeAll: (bytes) =>
            Effect.sync(() => {
              files.set(path, `${files.get(path) ?? ""}${new TextDecoder().decode(bytes)}`);
            }),
          sync: Effect.void,
        };
      }),
    rename: (from, to) => {
      const text = files.get(from);

      return text === undefined
        ? fail("NotFound", "rename", from)
        : Effect.sync(() => {
            files.delete(from);
            files.set(to, text);
          });
    },
    remove: (path) =>
      Effect.sync(() => {
        files.delete(path);
      }),
  });
};

/**
 * Like `withKeyStore`, with the key file in memory. A property runs a hundred times, and each
 * run's real file calls on a loaded machine (the whole repo's tests at once) took it past 20 s;
 * the examples keep the store on real files.
 */
const withKeyStoreInMemory = <A, E>(
  body: (file: string) => Effect.Effect<A, E, KeyStore | FileSystem.FileSystem>,
) => {
  const file = "/via/keys.json";

  return body(file).pipe(
    Effect.provide(KeyStore.layer(file)),
    Effect.provideService(FileSystem.FileSystem, memoryFileSystem()),
  );
};

/** A store on `file` of its own, as another process (`via keys`, a restarted `via serve`) has. */
const storeAt = (file: string) =>
  Layer.build(KeyStore.layer(file)).pipe(Effect.map(Context.get(KeyStore)));

/**
 * Two stores on `file`, as `via keys create` and a running `via serve` are:
 * each with its own in-process lock, and both taking the file's real lock
 * file. `contend` runs `effect` with a clock for them to wait on each other
 * with: a store that finds the lock file taken waits until the other removes
 * it, where it would poll for it on the real clock.
 */
const contendingStoresAt = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const clock = yield* Clock.clockWith(Effect.succeed);
    const lock = `${file}.lock`;
    let released = Deferred.makeUnsafe<void>();

    const watched = FileSystem.FileSystem.of({
      ...fs,
      remove: (path, options) =>
        fs.remove(path, options).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (path !== lock) return;
              Deferred.doneUnsafe(released, Effect.void);
              released = Deferred.makeUnsafe();
            }),
          ),
        ),
    });

    // Taken before the lock file is looked at, so a release in between isn't missed. A lock
    // file that can't be looked at is tried for again at once.
    const untilReleased = Effect.suspend(() => {
      const next = released;

      return fs.exists(lock).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((held) => (held ? Deferred.await(next) : Effect.void)),
      );
    });

    const waitingOnTheLock: Clock.Clock = { ...clock, sleep: () => untilReleased };

    const [cli, serve] = yield* Effect.all([storeAt(file), storeAt(file)]).pipe(
      Effect.provideService(FileSystem.FileSystem, watched),
    );

    return {
      cli,
      serve,
      contend: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, waitingOnTheLock),
    };
  });

const StoredLastUse = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, lastUsedAt: Schema.optional(Schema.String) })),
);

/** Each key's last use as the file holds it, by name. */
const storedLastUse = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const keys = yield* Schema.decodeEffect(StoredLastUse)(yield* fs.readFileString(file));

    return Object.fromEntries(keys.map((k) => [k.name, k.lastUsedAt]));
  });

/**
 * Signals each write `store` makes to its file, as `changes` reports it: `next` waits for the
 * first one not yet waited for. A key's last use is written off the request's path, so a test
 * waits for it before reading the file.
 */
const writesOf = (store: KeyStore["Service"]) =>
  Effect.gen(function* () {
    const signals = yield* Queue.unbounded<void>();
    yield* store.changes.pipe(
      Stream.runForEach(() => Queue.offer(signals, undefined)),
      Effect.forkChild,
    );
    // The signal `changes` gives at once, before any write.
    yield* Queue.take(signals);

    return { next: Queue.take(signals), pending: Queue.size(signals) };
  });

/**
 * Runs `effect` while moving the test clock on 50 ms at a time, letting real time pass for
 * pending file-system calls first, so a store waiting on a lock tries it again each step.
 */
const untilDone = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);

    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.withLive(Effect.sleep("2 millis"));
      yield* TestClock.adjust("50 millis");
    }

    return yield* Fiber.join(fiber);
  });

/** The time `millis` after `start`, as the key file writes it. */
const iso = (start: number, millis: number) => new Date(start + millis).toISOString();

layer(BunFileSystem.layer)("KeyStore", (it) => {
  it.effect("creates a via_ key that verifies to its name", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const created = yield* store.create("laptop");
        expect(created.key).toMatch(/^via_[A-Za-z0-9]{32}$/);
        expect(yield* store.verify(created.key)).toEqual(
          Option.some({ id: created.id, name: "laptop" }),
        );
      }),
    ),
  );

  it.effect("does not store the plaintext key", () =>
    withKeyStore((file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { key } = yield* (yield* KeyStore).create("laptop");
        expect(yield* fs.readFileString(file)).not.toContain(key);
      }),
    ),
  );

  it.effect("keeps the key file readable only by the owner", () =>
    withKeyStore((file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* (yield* KeyStore).create("laptop");
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
      }),
    ),
  );

  it.effect("rejects unknown keys", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        yield* store.create("laptop");
        expect(yield* store.verify("via_notarealkeynotarealkeynotareal")).toEqual(Option.none());
      }),
    ),
  );

  it.effect("lists keys without exposing them", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const { id } = yield* store.create("laptop");
        expect(yield* store.list).toEqual([
          { id, name: "laptop", createdAt: expect.any(String), lastUsedAt: null },
        ]);
      }),
    ),
  );

  it.effect("revoked keys stop verifying", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const { id, key } = yield* store.create("laptop");
        yield* store.revoke(id);
        expect(yield* store.verify(key)).toEqual(Option.none());
      }),
    ),
  );

  it.effect("revokes by name too, and fails on an unknown target", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        yield* store.create("laptop");
        yield* store.revoke("laptop");
        expect(yield* Effect.flip(store.revoke("laptop"))).toEqual(
          new KeyNotFoundError({ idOrName: "laptop" }),
        );
      }),
    ),
  );

  it.effect("refuses duplicate names", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        yield* store.create("laptop");
        const error = yield* Effect.flip(store.create("laptop"));
        expect(error).toEqual(new DuplicateKeyNameError({ name: "laptop" }));
      }),
    ),
  );

  it.effect("renames a key, which keeps verifying, now to its new name", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const { id, key } = yield* store.create("laptop");
        const renamed = yield* store.rename(id, "desktop");
        expect(renamed).toEqual({
          id,
          name: "desktop",
          createdAt: expect.any(String),
          lastUsedAt: null,
        });
        expect(yield* store.verify(key)).toEqual(Option.some({ id, name: "desktop" }));
        expect((yield* store.list).map((k) => k.name)).toEqual(["desktop"]);
      }),
    ),
  );

  it.effect("renames by name too, and fails on an unknown target", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        yield* store.create("laptop");
        yield* store.rename("laptop", "desktop");
        expect(yield* Effect.flip(store.rename("laptop", "phone"))).toEqual(
          new KeyNotFoundError({ idOrName: "laptop" }),
        );
      }),
    ),
  );

  it.effect("refuses to rename a key to another key's name", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        yield* store.create("laptop");
        yield* store.create("desktop");
        expect(yield* Effect.flip(store.rename("laptop", "desktop"))).toEqual(
          new DuplicateKeyNameError({ name: "desktop" }),
        );
        expect((yield* store.list).map((k) => k.name)).toEqual(["laptop", "desktop"]);
      }),
    ),
  );

  it.effect("keeps a key's hash and last use when it is renamed", () =>
    withKeyStore((file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* KeyStore;
        const written = yield* writesOf(store);
        const { key } = yield* store.create("laptop");
        yield* written.next;
        yield* store.verify(key);
        yield* written.next;
        const before = yield* storedLastUse(file);
        const { lastUsedAt } = yield* store.rename("laptop", "desktop");
        expect(yield* storedLastUse(file)).toEqual({ desktop: before["laptop"] });
        expect(lastUsedAt).toBe(before["laptop"]);
        expect(yield* fs.readFileString(file)).not.toContain(key);
      }),
    ),
  );

  it.effect("reports a stored hash that is not a SHA-256 digest as a corrupt file", () =>
    withKeyStore((file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const stored = {
          id: "k1",
          name: "laptop",
          hash: "abc",
          createdAt: "2024-01-01T00:00:00Z",
        };

        yield* fs.writeFileString(file, JSON.stringify([stored]));
        const error = yield* Effect.flip((yield* KeyStore).verify("via_anything"));
        expect(error).toBeInstanceOf(CorruptFileError);
      }),
    ),
  );

  it.effect("keeps every key created concurrently", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const names = ["a", "b", "c", "d", "e"];
        yield* Effect.forEach(names, store.create, { concurrency: "unbounded" });
        expect((yield* store.list).map((k) => k.name).toSorted()).toEqual(names);
      }),
    ),
  );

  it.effect("keeps every change made by two processes sharing the key file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;
      const { cli, serve, contend } = yield* contendingStoresAt(file);
      const revoked = yield* serve.create("old");
      const renamed = yield* cli.create("before");

      const names = ["a", "b", "c", "d", "e", "f", "g", "h"];

      yield* contend(
        Effect.all(
          [
            Effect.forEach(names.slice(0, 4), cli.create, { concurrency: "unbounded" }),
            Effect.forEach(names.slice(4), serve.create, { concurrency: "unbounded" }),
            cli.revoke(revoked.id),
            serve.rename(renamed.id, "renamed"),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      );

      expect((yield* serve.list).map((k) => k.name).toSorted()).toEqual([...names, "renamed"]);
    }),
  );

  it.effect("revokes only the key with a matching id when another key is named after that id", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const laptop = yield* store.create("laptop");
        const namedLikeId = yield* store.create(laptop.id);
        yield* store.revoke(laptop.id);
        expect(yield* store.verify(namedLikeId.key)).toEqual(
          Option.some({ id: namedLikeId.id, name: laptop.id }),
        );
      }),
    ),
  );

  it.effect("lists when a key was last used", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const { key } = yield* store.create("laptop");
        const start = yield* Clock.currentTimeMillis;
        yield* TestClock.adjust("90 seconds");
        yield* store.verify(key);
        yield* TestClock.adjust("10 seconds");
        expect((yield* store.list)[0]?.lastUsedAt).toBe(iso(start, 90_000));
      }),
    ),
  );

  it.effect("writes a key's last use to the file at most once a minute", () =>
    withKeyStore((file) =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const written = yield* writesOf(store);
        const { key } = yield* store.create("laptop");
        yield* written.next;
        const start = yield* Clock.currentTimeMillis;

        yield* store.verify(key);
        yield* written.next;
        expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, 0) });

        for (const _ of Array.from({ length: 5 })) {
          yield* TestClock.adjust("10 seconds");
          yield* store.verify(key);
        }

        expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, 0) });
        expect((yield* store.list)[0]?.lastUsedAt).toBe(iso(start, 50_000));

        yield* TestClock.adjust("10 seconds");
        yield* store.verify(key);
        yield* written.next;
        expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, 60_000) });
        // Writes run one at a time, so one the five uses within the minute made would have
        // signalled before the last.
        expect(yield* written.pending).toBe(0);
      }),
    ),
  );

  it.effect("keeps a key's last use across a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;
      const serve = yield* storeAt(file);
      const written = yield* writesOf(serve);
      const { key } = yield* serve.create("laptop");
      yield* written.next;
      const start = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust("1 hour");
      yield* serve.verify(key);
      yield* written.next;

      const restarted = yield* storeAt(file);
      expect((yield* restarted.list)[0]?.lastUsedAt).toBe(iso(start, 3_600_000));
    }),
  );

  it.effect("reads a key file written before keys recorded their last use", () =>
    withKeyStore((file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const createdAt = "2024-01-01T00:00:00.000Z";
        const stored = { id: "k1", name: "laptop", hash: "0".repeat(64), createdAt };
        yield* fs.writeFileString(file, JSON.stringify([stored]));
        expect(yield* (yield* KeyStore).list).toEqual([
          { id: "k1", name: "laptop", createdAt, lastUsedAt: null },
        ]);
      }),
    ),
  );

  it.effect("verifies and lists without reading the key file again while it is unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;
      let reads = 0;

      const counting = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (path, encoding) => {
          if (path === file) reads += 1;

          return fs.readFileString(path, encoding);
        },
      });

      const store = yield* storeAt(file).pipe(
        Effect.provideService(FileSystem.FileSystem, counting),
      );

      const written = yield* writesOf(store);
      const { key } = yield* store.create("laptop");
      yield* store.verify(key);
      yield* written.next;
      yield* written.next;
      reads = 0;

      yield* store.verify(key);
      yield* store.list;
      yield* store.verify(key);
      expect(reads).toBe(1);
    }),
  );

  it.effect("sees another process's change to the key file on the next use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;
      const cli = yield* storeAt(file);
      const serve = yield* storeAt(file);
      const written = yield* writesOf(serve);
      const { id, key } = yield* cli.create("laptop");
      yield* serve.verify(key);
      yield* written.next;

      // The same length, so the file's size doesn't change, and likely within the millisecond.
      yield* cli.rename(id, "laptoq");
      expect(yield* serve.verify(key)).toEqual(Option.some({ id, name: "laptoq" }));
      yield* cli.revoke(id);
      expect(yield* serve.verify(key)).toEqual(Option.none());
      expect(yield* serve.list).toEqual([]);
    }),
  );

  it.effect("verifies a key at once while another process holds the key file's lock", () =>
    withKeyStore((file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* KeyStore;
        const written = yield* writesOf(store);
        const { id, key } = yield* store.create("laptop");
        yield* written.next;
        const start = yield* Clock.currentTimeMillis;
        // Another process's lock, fresh by the test clock, which is far behind real time.
        yield* fs.writeFileString(`${file}.lock`, "another-process");

        // A key's first use is always due to be written.
        const verifying = yield* store.verify(key).pipe(Effect.forkChild);

        const verified = yield* Fiber.join(verifying).pipe(
          Effect.timeout("2 seconds"),
          // Bounds a verify stuck behind the lock in real time; the store waits on the test clock.
          TestClock.withLive,
        );

        expect(verified).toEqual(Option.some({ id, name: "laptop" }));
        yield* fs.remove(`${file}.lock`);
        yield* untilDone(written.next);
        expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, 0) });
      }),
    ),
  );

  it.effect("never brings back a key revoked while its last use is being written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;
      const { cli, serve, contend } = yield* contendingStoresAt(file);
      const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const created = yield* Effect.forEach(names, serve.create);
      // A minute on, every verify finds its key's last use stale, and so writes it, while the
      // other store revokes the key.
      yield* TestClock.adjust("1 minute");

      yield* contend(
        Effect.forEach(
          created,
          ({ id, key }) =>
            Effect.all([serve.verify(key), cli.revoke(id)], {
              concurrency: "unbounded",
              discard: true,
            }),
          { concurrency: "unbounded", discard: true },
        ),
      );

      expect(yield* serve.list).toEqual([]);
    }),
  );

  /** Seconds between two uses of a key: often under the minute its stored use may lag, sometimes not. */
  const gaps = Arbitrary.array(
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 90 }))),
    { minLength: 1, maxLength: 20 },
  );

  it.effect.prop(
    "the file's last use lags the real one by under a minute, and changes at most once a minute",
    { gaps },
    ({ gaps: values }) =>
      withKeyStoreInMemory((file) =>
        Effect.gen(function* () {
          const store = yield* KeyStore;
          const writes = yield* writesOf(store);
          const { key } = yield* store.create("laptop");
          yield* writes.next;
          const start = yield* Clock.currentTimeMillis;
          let now = 0;
          let written: number | undefined;

          for (const seconds of values) {
            yield* TestClock.adjust(Duration.seconds(seconds));
            now += seconds * 1000;
            yield* store.verify(key);

            if (written === undefined || now - written >= 60_000) {
              written = now;
              yield* writes.next;
            }

            expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, written) });
            expect((yield* store.list)[0]?.lastUsedAt).toBe(iso(start, now));
          }
        }),
      ),
    // A hundred runs, where an example makes one: a loaded machine (the whole repo's tests at
    // once) needs longer.
    { timeout: 20_000 },
  );

  it.effect("signals now, then after every change it writes, but not when read", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const signals = yield* SubscriptionRef.make(0);
        yield* store.changes.pipe(
          Stream.runForEach(() => SubscriptionRef.update(signals, (n) => n + 1)),
          Effect.forkChild,
        );

        const settled = Effect.andThen(
          Effect.repeat(Effect.yieldNow, { times: 20 }),
          SubscriptionRef.get(signals),
        );

        expect(yield* settled).toBe(1);
        const { key } = yield* store.create("laptop");
        yield* store.list;
        expect(yield* settled).toBe(2);
        // The first use is written, off the request's path; another within the minute isn't.
        yield* store.verify(key);
        yield* store.verify(key);
        yield* SubscriptionRef.changes(signals).pipe(
          Stream.filter((n) => n >= 3),
          Stream.runHead,
        );
        expect(yield* settled).toBe(3);
        yield* store.rename("laptop", "desktop");
        expect(yield* settled).toBe(4);
        yield* store.revoke("desktop");
        expect(yield* settled).toBe(5);
      }),
    ),
  );
});
