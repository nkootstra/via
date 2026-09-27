import { readJsonFile, writeJsonFile } from "@via/config";
import { Context, DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { createHash, timingSafeEqual } from "node:crypto";

const StoredKeys = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    createdAt: Schema.String,
  }),
);

export class DuplicateKeyNameError extends Schema.TaggedError<DuplicateKeyNameError>()(
  "DuplicateKeyNameError",
  { name: Schema.String },
) {
  override get message() {
    return `A key named "${this.name}" already exists`;
  }
}

export class KeyNotFoundError extends Schema.TaggedError<KeyNotFoundError>()("KeyNotFoundError", {
  idOrName: Schema.String,
}) {
  override get message() {
    return `No key with id or name "${this.idOrName}"`;
  }
}

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

const hash = (key: string) => createHash("sha256").update(key).digest();

const make = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const read = readJsonFile(path, StoredKeys, () => []).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );

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
    });

    const list = read.pipe(
      Effect.map((keys) => keys.map(({ id, name, createdAt }) => ({ id, name, createdAt }))),
    );

    const revoke = Effect.fn("KeyStore.revoke")(function* (idOrName: string) {
      const keys = yield* read;
      const remaining = keys.filter((k) => k.id !== idOrName && k.name !== idOrName);

      if (remaining.length === keys.length) return yield* new KeyNotFoundError({ idOrName });
      yield* write(remaining);
    });

    const verify = Effect.fn("KeyStore.verify")(function* (key: string) {
      const candidate = hash(key);

      const match = (yield* read).find((k) =>
        timingSafeEqual(candidate, Buffer.from(k.hash, "hex")),
      );

      return Option.fromNullishOr(match).pipe(Option.map(({ id, name }) => ({ id, name })));
    });

    return { create, list, revoke, verify };
  });

/** API keys for clients of `via serve`; only SHA-256 hashes are stored. */
export class KeyStore extends Context.Service<KeyStore, Effect.Success<ReturnType<typeof make>>>()(
  "via/KeyStore",
) {
  static readonly layer = (path: string) => Layer.effect(KeyStore, make(path));
}
