import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { CorruptFileError } from "@via/config";
import {
  Clock,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
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

/** A store on `file` of its own, as another process (`via keys`, a restarted `via serve`) has. */
const storeAt = (file: string) =>
  Layer.build(KeyStore.layer(file)).pipe(Effect.map(Context.get(KeyStore)));

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
      // Two layers are two stores, each with its own in-process lock, as `via keys create`
      // and a running `via serve` are.
      const cli = yield* storeAt(file);
      const serve = yield* storeAt(file);
      const revoked = yield* serve.create("old");

      const names = ["a", "b", "c", "d", "e", "f", "g", "h"];

      // Live time: a store waiting on the other's lock file polls for it in real time.
      yield* TestClock.withLive(
        Effect.all(
          [
            Effect.forEach(names.slice(0, 4), cli.create, { concurrency: "unbounded" }),
            Effect.forEach(names.slice(4), serve.create, { concurrency: "unbounded" }),
            cli.revoke(revoked.id),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      );

      expect((yield* serve.list).map((k) => k.name).toSorted()).toEqual(names);
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
        const { key } = yield* store.create("laptop");
        const start = yield* Clock.currentTimeMillis;

        yield* store.verify(key);
        expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, 0) });

        for (const _ of Array.from({ length: 5 })) {
          yield* TestClock.adjust("10 seconds");
          yield* store.verify(key);
        }

        expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, 0) });
        expect((yield* store.list)[0]?.lastUsedAt).toBe(iso(start, 50_000));

        yield* TestClock.adjust("10 seconds");
        yield* store.verify(key);
        expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, 60_000) });
      }),
    ),
  );

  it.effect("keeps a key's last use across a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;
      const serve = yield* storeAt(file);
      const { key } = yield* serve.create("laptop");
      const start = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust("1 hour");
      yield* serve.verify(key);

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

  it.effect("never brings back a key revoked while its last use is being written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;
      const cli = yield* storeAt(file);
      const serve = yield* storeAt(file);
      const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const created = yield* Effect.forEach(names, serve.create);

      // Live time: every verify finds its key's last use stale, and so writes it, while the
      // other store revokes the key; and a store waiting on the other's lock polls in real time.
      yield* TestClock.withLive(
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
      withKeyStore((file) =>
        Effect.gen(function* () {
          const store = yield* KeyStore;
          const { key } = yield* store.create("laptop");
          const start = yield* Clock.currentTimeMillis;
          let now = 0;
          let written: number | undefined;

          for (const seconds of values) {
            yield* TestClock.adjust(Duration.seconds(seconds));
            now += seconds * 1000;
            yield* store.verify(key);

            if (written === undefined || now - written >= 60_000) written = now;
            expect(yield* storedLastUse(file)).toEqual({ laptop: iso(start, written) });
            expect((yield* store.list)[0]?.lastUsedAt).toBe(iso(start, now));
          }
        }),
      ),
    // Every run writes real files; a loaded machine (the whole repo's tests at once) needs longer.
    { timeout: 20_000 },
  );

  it.effect("signals now, then after every change it writes, but not when read", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const signals = yield* Ref.make(0);
        yield* store.changes.pipe(
          Stream.runForEach(() => Ref.update(signals, (n) => n + 1)),
          Effect.forkChild,
        );

        const settled = Effect.andThen(
          Effect.repeat(Effect.yieldNow, { times: 20 }),
          Ref.get(signals),
        );

        expect(yield* settled).toBe(1);
        const { key } = yield* store.create("laptop");
        yield* store.list;
        expect(yield* settled).toBe(2);
        // The first use is written; another within the minute isn't.
        yield* store.verify(key);
        yield* store.verify(key);
        expect(yield* settled).toBe(3);
        yield* store.revoke("laptop");
        expect(yield* settled).toBe(4);
      }),
    ),
  );
});
