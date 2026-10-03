import { Effect, FileSystem, Option, Ref } from "effect";

/**
 * A stamp of `path` as it is now: its inode, modification time and size, or `missing`. A file
 * replaced as `writeJsonFile` replaces it, by renaming a new file over it, gets a new inode, so
 * its stamp changes even within the clock's resolution. None when the file system can't tell,
 * so a cache keyed on it reads every time.
 */
export const fileStamp = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.stat(path).pipe(
      Effect.map((info) =>
        Option.all([info.ino, info.mtime]).pipe(
          Option.map(([ino, mtime]) => `${ino}:${mtime.getTime()}:${info.size}`),
        ),
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedSome("missing")),
    );
  });

/**
 * `read`, run again only once `stamp` or `revision` has changed since the last time it
 * succeeded: `stamp` for another process's writes (a `fileStamp`), `revision` for this
 * process's. The stamp is taken before reading, so a value is never older than its stamp.
 */
export const cachedUntilChanged = <A, E, R, E2, R2>(options: {
  readonly stamp: Effect.Effect<Option.Option<string>, E2, R2>;
  readonly revision: Effect.Effect<number>;
  readonly read: Effect.Effect<A, E, R>;
}) =>
  Effect.map(
    Ref.make(
      Option.none<{ readonly stamp: string; readonly revision: number; readonly value: A }>(),
    ),
    (last) =>
      Effect.gen(function* () {
        const revision = yield* options.revision;
        const stamp = yield* options.stamp;

        const hit = Option.filter(
          yield* Ref.get(last),
          (entry) => entry.revision === revision && Option.contains(stamp, entry.stamp),
        );

        if (Option.isSome(hit)) return hit.value.value;
        const value = yield* options.read;
        yield* Ref.set(
          last,
          Option.map(stamp, (at) => ({ stamp: at, revision, value })),
        );

        return value;
      }),
  );
