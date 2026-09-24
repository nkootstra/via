import { Effect, FileSystem, Random, Schema } from "effect";
import { dirname } from "node:path";

export class CorruptFileError extends Schema.TaggedError<CorruptFileError>()("CorruptFileError", {
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Corrupt file ${this.path}: ${this.reason}`;
  }
}

/** Read and decode a JSON file, or return `fallback()` when it does not exist. */
export const readJsonFile = Effect.fn("readJsonFile")(function* <
  S extends Schema.Codec<unknown, unknown>,
>(path: string, schema: S, fallback: () => S["Type"]) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return fallback();
  const text = yield* fs.readFileString(path);
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((error) => new CorruptFileError({ path, reason: error.message })),
  );
});

/** Encode and write JSON owner-only via temp file + rename, so readers never see a partial file. */
export const writeJsonFile = Effect.fn("writeJsonFile")(function* <
  S extends Schema.Codec<unknown, unknown>,
>(path: string, schema: S, value: S["Type"]) {
  const fs = yield* FileSystem.FileSystem;
  // `value` is already typed as the schema's Type, so encoding can only fail on a programming error.
  const encoded = yield* Schema.encodeEffect(schema)(value).pipe(Effect.orDie);
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${yield* Random.nextInt}.tmp`;
  yield* fs.writeFileString(tmp, `${JSON.stringify(encoded, null, 2)}\n`, { mode: 0o600 });
  yield* fs.chmod(tmp, 0o600);
  yield* fs.rename(tmp, path);
});
