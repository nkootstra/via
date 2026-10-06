import { BunFileSystem } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { ownedFiles } from "./index.ts";

const Greeting = Schema.Struct({ hello: Schema.String });

// Made with a FileSystem, then used where none is provided: what a store's methods need.
const made = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();

  return { files: yield* ownedFiles, file: `${dir}/nested/data.json` };
}).pipe(Effect.provide(BunFileSystem.layer));

it.effect("reads, writes, locks and stamps with the FileSystem it was made with", () =>
  Effect.gen(function* () {
    const { files, file } = yield* made;

    expect(yield* files.read(file, Greeting, () => ({ hello: "missing" }))).toEqual({
      hello: "missing",
    });
    expect(yield* files.stamp(file)).toEqual(Option.some("missing"));

    yield* files.locked(file, files.write(file, Greeting, { hello: "world" }));

    expect(yield* files.read(file, Greeting, () => ({ hello: "missing" }))).toEqual({
      hello: "world",
    });
    expect(Option.contains(yield* files.stamp(file), "missing")).toBe(false);
  }),
);
