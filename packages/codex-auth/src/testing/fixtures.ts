// Test-only: the golden fixtures in ./fixtures, taken from openai/codex (see SOURCES.md).
import { Effect, FileSystem, Schema } from "effect";
import { fileURLToPath } from "node:url";

const RefreshErrorFixtures = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ status: Schema.Int, body: Schema.JsonObject })),
);

/** One refresh failure codex's own tests expect from the issuer, from refresh-errors.json. */
export const codexRefreshErrorFixture = (name: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(fileURLToPath(new URL("./fixtures/refresh-errors.json", import.meta.url))),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RefreshErrorFixtures)),
    Effect.flatMap((fixtures) => Effect.fromNullishOr(fixtures[name])),
    // Test fixture: a missing or malformed fixture is a bug in the test.
    Effect.orDie,
  );
