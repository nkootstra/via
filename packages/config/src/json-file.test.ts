import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { CorruptFileError, readJsonFile, writeJsonFile } from "./index.ts";

const Greeting = Schema.Struct({ hello: Schema.String });

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
});

layer(BunFileSystem.layer)("json files", (it) => {
  it.effect("round-trips data, creating parent directories", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDir}/nested/data.json`;
      yield* writeJsonFile(file, Greeting, { hello: "world" });
      expect(yield* readJsonFile(file, Greeting, () => ({ hello: "fallback" }))).toEqual({
        hello: "world",
      });
    }),
  );

  it.effect("returns the fallback when the file does not exist", () =>
    Effect.gen(function* () {
      const file = `${yield* tempDir}/missing.json`;
      expect(yield* readJsonFile(file, Greeting, () => ({ hello: "fallback" }))).toEqual({
        hello: "fallback",
      });
    }),
  );

  it.effect("fails with CorruptFileError when the content does not match the schema", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* tempDir}/bad.json`;
      yield* fs.writeFileString(file, '{"hello": 42}');
      const error = yield* Effect.flip(readJsonFile(file, Greeting, () => ({ hello: "x" })));
      expect(error).toBeInstanceOf(CorruptFileError);
    }),
  );

  it.effect("writes files readable only by the owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* tempDir}/secret.json`;
      yield* writeJsonFile(file, Greeting, { hello: "x" });
      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("leaves no temporary files behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* tempDir;
      yield* writeJsonFile(`${dir}/a.json`, Greeting, { hello: "1" });
      yield* writeJsonFile(`${dir}/a.json`, Greeting, { hello: "2" });
      expect(yield* fs.readDirectory(dir)).toEqual(["a.json"]);
    }),
  );
});
