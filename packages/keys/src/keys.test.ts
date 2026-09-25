import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { CorruptFileError } from "@via/config";
import { Effect, FileSystem, Option } from "effect";
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

  it.effect("rejects unknown keys", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        yield* store.create("laptop");
        expect(
          yield* store.verify("via_notarealkeynotarealkeynotareal"),
        ).toEqual(Option.none());
      }),
    ),
  );

  it.effect("lists keys without exposing them", () =>
    withKeyStore(() =>
      Effect.gen(function* () {
        const store = yield* KeyStore;
        const { id } = yield* store.create("laptop");
        expect(yield* store.list).toEqual([
          { id, name: "laptop", createdAt: expect.any(String) },
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

  it.effect(
    "reports a stored hash that is not a SHA-256 digest as a corrupt file",
    () =>
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
          const error = yield* Effect.flip(
            (yield* KeyStore).verify("via_anything"),
          );
          expect(error).toBeInstanceOf(CorruptFileError);
        }),
      ),
  );
});
