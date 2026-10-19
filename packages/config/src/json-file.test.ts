import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, PlatformError, Schema } from "effect";
import { CorruptFileError, readJsonFile, writeJsonFile } from "./index.ts";

const Greeting = Schema.Struct({ hello: Schema.String });

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.makeTempDirectoryScoped();
});

/**
 * A failed `sync` of `path`, as a real file system reports an errno `code` it has no reason for,
 * such as EINVAL: as `reason`, with the errno in its cause.
 */
const syncFailure = (reason: PlatformError.SystemErrorTag, code: string, path: string) =>
  PlatformError.systemError({
    _tag: reason,
    module: "FileSystem",
    method: "sync",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(code), { code }),
  });

/** The file system, except that flushing `dir` itself fails with the errno `code`. */
const directorySyncFails = (fs: FileSystem.FileSystem, dir: string, code: string) =>
  FileSystem.FileSystem.of({
    ...fs,
    open: (path, options) =>
      Effect.map(fs.open(path, options), (handle) =>
        path === dir
          ? // The handle's methods live on its prototype, so it is extended rather than spread.
            Object.create(handle, {
              sync: { value: Effect.fail(syncFailure("Unknown", code, path)) },
            })
          : handle,
      ),
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
      expect(error.message.startsWith(`${file} can't be read: `)).toBe(true);
      expect(error.message).toContain("hello");
      expect(error.message.endsWith(". Fix it or restore it from a backup, then try again")).toBe(
        true,
      );
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

  it.effect("creates missing parent directories readable only by the owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${yield* tempDir}/nested`;
      yield* writeJsonFile(`${dir}/secret.json`, Greeting, { hello: "x" });
      expect((yield* fs.stat(dir)).mode & 0o777).toBe(0o700);
    }),
  );

  it.effect("flushes the new contents to disk before they replace the file, then the rename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* tempDir;
      const file = `${dir}/a.json`;
      const calls: Array<string> = [];

      // Records which file each flush and rename touches: a rename of contents that were never
      // flushed can survive a crash as an empty file, and a rename whose directory was never
      // flushed can be undone by one, bringing back the old file.
      const recording = FileSystem.FileSystem.of({
        ...fs,
        open: (path, options) =>
          Effect.map(fs.open(path, options), (handle) =>
            // The handle's methods live on its prototype, so it is extended rather than spread.
            Object.create(handle, {
              sync: {
                value: Effect.andThen(
                  handle.sync,
                  Effect.sync(() => calls.push(`sync ${path}`)),
                ),
              },
            }),
          ),
        rename: (from, to) =>
          Effect.andThen(
            fs.rename(from, to),
            Effect.sync(() => calls.push(`rename ${from}`)),
          ),
      });

      yield* writeJsonFile(file, Greeting, { hello: "x" }).pipe(
        Effect.provideService(FileSystem.FileSystem, recording),
      );

      const tmp = calls.at(-2)?.slice("rename ".length);
      expect(calls).toEqual([`sync ${tmp}`, `rename ${tmp}`, `sync ${dir}`]);
      expect(yield* readJsonFile(file, Greeting, () => ({ hello: "fallback" }))).toEqual({
        hello: "x",
      });
    }),
  );

  it.effect.each(["EINVAL", "ENOTSUP"])(
    "writes the file where the directory can't be flushed (%s)",
    (code) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const file = `${dir}/a.json`;

        yield* writeJsonFile(file, Greeting, { hello: "x" }).pipe(
          Effect.provideService(FileSystem.FileSystem, directorySyncFails(fs, dir, code)),
        );

        expect(yield* readJsonFile(file, Greeting, () => ({ hello: "fallback" }))).toEqual({
          hello: "x",
        });
      }),
  );

  it.effect("fails a write whose directory can't be flushed for an I/O error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* tempDir;

      const exit = yield* Effect.exit(
        writeJsonFile(`${dir}/a.json`, Greeting, { hello: "x" }).pipe(
          Effect.provideService(FileSystem.FileSystem, directorySyncFails(fs, dir, "EIO")),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("removes its temporary file when the write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* tempDir;
      // A non-empty directory where the file should go makes the final rename fail.
      yield* fs.makeDirectory(`${dir}/a.json/occupied`, { recursive: true });
      yield* Effect.flip(writeJsonFile(`${dir}/a.json`, Greeting, { hello: "x" }));
      expect(yield* fs.readDirectory(dir)).toEqual(["a.json"]);
    }),
  );
});
