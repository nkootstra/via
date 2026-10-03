import { Effect, FileSystem, Option, Random, Schema } from "effect";
import { dirname } from "node:path";

export class CorruptFileError extends Schema.TaggedError<CorruptFileError>()("CorruptFileError", {
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.path} can't be read: ${this.reason}. Fix it or restore it from a backup, then try again`;
  }
}

/** Read and decode a JSON file, or return `fallback()` when it does not exist. */
export const readJsonFile = Effect.fn("readJsonFile")(function* <
  S extends Schema.Codec<unknown, unknown>,
>(path: string, schema: S, fallback: () => S["Type"]) {
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs.readFileString(path).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );

  if (Option.isNone(text)) return fallback();

  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text.value).pipe(
    Effect.mapError((error) => new CorruptFileError({ path, reason: error.message })),
  );
});

/**
 * Encode and write JSON owner-only via a flushed temp file + rename, so readers never see a
 * partial file and a crash leaves the old contents or the new ones.
 */
export const writeJsonFile = Effect.fn("writeJsonFile")(function* <
  S extends Schema.Codec<unknown, unknown>,
>(path: string, schema: S, value: S["Type"]) {
  const fs = yield* FileSystem.FileSystem;
  // `value` is already typed as the schema's Type, so encoding can only fail on a programming error.
  const encoded = yield* Schema.encodeEffect(schema)(value).pipe(Effect.orDie);
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${yield* Random.nextInt}.tmp`;
  yield* Effect.gen(function* () {
    // Flushed before the rename, so a crash can't leave the file renamed but empty.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(tmp, { flag: "w", mode: 0o600 });
        yield* file.writeAll(new TextEncoder().encode(`${JSON.stringify(encoded, null, 2)}\n`));
        yield* file.sync;
      }),
    );
    yield* fs.chmod(tmp, 0o600);
    yield* fs.rename(tmp, path);
  }).pipe(
    // The temp file may hold secrets (tokens, key hashes), so a failed write must not leave it behind.
    Effect.onError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore)),
  );
});
