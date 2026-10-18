import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Data, type Duration, Effect, FileSystem, Predicate, Schedule, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
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
      yield* Effect.scoped(fs.open(filename, { flag: "a+", mode: 0o600 }));
      yield* fs.chmod(filename, 0o600);

      const database = yield* SqliteClient.make({
        filename,
        disableWAL: true,
        busyTimeout: 0,
      }).pipe(Effect.provide(Reactivity.layer));

      const failed = (error: { readonly message: string }) =>
        new CorruptFileError({ path: filename, reason: error.message });

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
