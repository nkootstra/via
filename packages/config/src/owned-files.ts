import { type Duration, Effect, FileSystem, type Schema } from "effect";
import { withFileLock } from "./file-lock.ts";
import { fileStamp } from "./file-stamp.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

/**
 * via's own files, read, written, locked and stamped with the `FileSystem` taken here, so a
 * store takes it once, as it is made, and its methods need nothing more.
 */
export const ownedFiles = Effect.map(FileSystem.FileSystem, (fs) => {
  const provide = Effect.provideService(FileSystem.FileSystem, fs);

  return {
    /** As `readJsonFile`. */
    read: <S extends Schema.Codec<unknown, unknown>>(
      path: string,
      schema: S,
      fallback: () => S["Type"],
    ) => provide(readJsonFile(path, schema, fallback)),
    /** As `writeJsonFile`. */
    write: <S extends Schema.Codec<unknown, unknown>>(path: string, schema: S, value: S["Type"]) =>
      provide(writeJsonFile(path, schema, value)),
    /** As `withFileLock`. */
    locked: <A, E, R>(
      path: string,
      effect: Effect.Effect<A, E, R>,
      options?: { readonly giveUpAfter?: Duration.Input },
    ) => provide(withFileLock(path, effect, options)),
    /** As `fileStamp`. */
    stamp: (path: string) => provide(fileStamp(path)),
  };
});
