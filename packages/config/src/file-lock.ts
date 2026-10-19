import { SqliteClient } from "@effect/sql-sqlite-bun";
import {
  Data,
  type Duration,
  Effect,
  FileSystem,
  Predicate,
  Random,
  Schedule,
  Schema,
} from "effect";
import { Reactivity } from "effect/reactivity";
import { dirname } from "node:path";
import { CorruptFileError } from "./json-file.ts";

const GIVE_UP_AFTER: Duration.Input = "10 seconds";

class LockBusy extends Data.TaggedError("LockBusy") {}

/** Other processes kept `path` locked for longer than a waiter waits. */
export class FileLockTimeoutError extends Schema.TaggedError<FileLockTimeoutError>()(
  "FileLockTimeoutError",
  { path: Schema.String },
) {
  override get message() {
    return `${this.path} is locked by another via process; try again`;
  }
}

/**
 * Creates `filename` owner-only unless it exists, never opening it. On POSIX, closing any
 * descriptor of a file drops every lock the process holds on it, a lock another fiber may be
 * holding; so the file is made under another name and linked into place, which fails when
 * another fiber or process got there first. Left to SQLite, it would be readable by others
 * until the chmod after, long enough for another user to open it and hold a lock forever.
 */
const createOwnerOnly = (fs: FileSystem.FileSystem, filename: string) =>
  Effect.gen(function* () {
    if (yield* fs.exists(filename)) return;
    const fresh = `${filename}.${yield* Random.nextInt}.tmp`;

    yield* Effect.gen(function* () {
      yield* Effect.scoped(fs.open(fresh, { flag: "wx", mode: 0o600 }));
      // The mode given to open is narrowed by the umask, never widened; this is for a umask
      // that clears the owner's bits.
      yield* fs.chmod(fresh, 0o600);
      yield* fs
        .link(fresh, filename)
        .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
    }).pipe(
      // The temporary name holds nothing; a leftover would only clutter the directory, so a
      // failure to remove it is no reason to fail the lock.
      Effect.ensuring(fs.remove(fresh, { force: true }).pipe(Effect.ignore)),
    );
  });

/**
 * Runs `effect` while holding SQLite's process lock on `<path>.lock.db`.
 * The OS keeps a paused process exclusive and releases its lock when it exits.
 * The file stays: removing it would let another process lock a different inode.
 */
export const withFileLock = <A, E, R>(
  path: string,
  effect: Effect.Effect<A, E, R>,
  { giveUpAfter = GIVE_UP_AFTER }: { readonly giveUpAfter?: Duration.Input } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filename = `${path}.lock.db`;
      yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
      yield* createOwnerOnly(fs, filename);

      const failed = (error: { readonly message: string }) =>
        new CorruptFileError({ path: filename, reason: error.message });

      const database = yield* SqliteClient.make({
        filename,
        disableWAL: true,
        busyTimeout: 0,
      }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(failed));

      // Changes the mode by name, opening no descriptor. The file holds no data, only the lock.
      yield* fs.chmod(filename, 0o600);

      const connection = yield* database.reserve.pipe(Effect.mapError(failed));

      const acquire = connection.executeRaw("BEGIN IMMEDIATE", []).pipe(
        Effect.catchReason("SqlError", "LockTimeoutError", () => Effect.fail(new LockBusy())),
        Effect.retry({
          schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: giveUpAfter })),
          while: Predicate.isTagged("LockBusy"),
        }),
        Effect.catchTag("LockBusy", () => Effect.fail(new FileLockTimeoutError({ path }))),
        Effect.catchTag("SqlError", (error) => Effect.fail(failed(error))),
      );

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.acquireUseRelease(
          // Preserve the caller's interrupt status; the scoped database also closes after BEGIN.
          restore(acquire),
          () => restore(effect),
          () =>
            connection.executeRaw("ROLLBACK", []).pipe(
              // Closing the scoped connection still releases the OS lock if rollback fails.
              Effect.catchTag("SqlError", (error) =>
                Effect.logWarning("Could not release a file lock", error),
              ),
            ),
        ),
      );
    }),
  );
