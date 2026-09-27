// Test-only: the golden fixtures in ./fixtures, taken from openai/codex (see SOURCES.md).
import { Effect, FileSystem, Schema } from "effect";
import { fileURLToPath } from "node:url";

/** Reads a golden fixture from ./fixtures. */
export const codexFixture = (name: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))),
  ).pipe(
    // Test fixture: a missing fixture file is a bug in the test.
    Effect.orDie,
  );

const ErrorFixtures = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      status: Schema.Int,
      headers: Schema.Record(Schema.String, Schema.String),
      body: Schema.Json,
    }),
  ),
);

const RefreshErrorFixtures = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ status: Schema.Int, body: Schema.JsonObject })),
);

const entry = <A>(
  file: string,
  schema: Schema.Decoder<Readonly<Record<string, A>>>,
  name: string,
) =>
  codexFixture(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.flatMap((fixtures) => Effect.fromNullishOr(fixtures[name])),
    // Test fixture: a missing or malformed fixture is a bug in the test.
    Effect.orDie,
  );

/** One HTTP error codex's own tests expect from the backend, from errors.json. */
export const codexErrorFixture = (name: string) => entry("errors.json", ErrorFixtures, name);

/** One refresh failure codex's own tests expect from the issuer, from refresh-errors.json. */
export const codexRefreshErrorFixture = (name: string) =>
  entry("refresh-errors.json", RefreshErrorFixtures, name);
