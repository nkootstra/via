import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { CorruptFileError } from "@via/config";
import { Context, Effect, FileSystem, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { DuplicateKeyNameError, KeyNotFoundError, KeyStore } from "./index.ts";

const withKeyStore = <A, E>(
  body: (file: string) => Effect.Effect<A, E, KeyStore | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${yield* fs.makeTempDirectoryScoped()}/keys.json`;

    return yield* body(file).pipe(Effect.provide(KeyStore.layer(file)));
  });

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
        expect(yield* store.list).toEqual([{ id, name: "laptop", createdAt: expect.any(String) }]);
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
      const storeAt = Layer.build(KeyStore.layer(file)).pipe(Effect.map(Context.get(KeyStore)));
      const cli = yield* storeAt;
      const serve = yield* storeAt;
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
});
