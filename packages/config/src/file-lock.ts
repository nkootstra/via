import { Clock, Data, Effect, FileSystem, Option, Predicate, Schedule, Schema } from "effect";
import { dirname } from "node:path";

// A holder only reads and rewrites a small file, which takes milliseconds, so a lock this old
// was left by a process that died holding it. Taking it over has a narrow race (two waiters
// can both judge it stale and both proceed), which is accepted: it needs a crash first.
const STALE_AFTER_MS = 5_000;

// Longer than STALE_AFTER_MS, so a crashed holder's lock is taken over before a waiter gives up.
const GIVE_UP_AFTER = "10 seconds";

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

/** Creates the lock file if no one holds it; whether it did. */
const tryCreate = (fs: FileSystem.FileSystem, lock: string) =>
  fs.writeFileString(lock, "", { flag: "wx", mode: 0o600 }).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
  );

const acquire = (path: string, lock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (yield* tryCreate(fs, lock)) return;
    const now = yield* Clock.currentTimeMillis;

    // The holder may release the lock between the failed create and this stat.
    const stale = yield* fs.stat(lock).pipe(
      Effect.map((info) =>
        Option.exists(info.mtime, (mtime) => now - mtime.getTime() > STALE_AFTER_MS),
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    );

    if (stale) {
      yield* fs.remove(lock, { force: true });

      if (yield* tryCreate(fs, lock)) return;
    }

    return yield* new LockBusy();
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: GIVE_UP_AFTER })),
      while: Predicate.isTagged("LockBusy"),
    }),
    Effect.catchTag("LockBusy", () => Effect.fail(new FileLockTimeoutError({ path }))),
  );

/**
 * Runs `effect` while holding an exclusive lock on `path`, shared with every other process
 * that locks it: a `<path>.lock` file, created with O_EXCL and removed afterwards. Guards a
 * read-modify-write of `path` against another via process (the CLI next to `via serve`).
 */
export const withFileLock = <A, E, R>(path: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = `${path}.lock`;
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });

    return yield* Effect.acquireUseRelease(
      acquire(path, lock),
      () => effect,
      () => fs.remove(lock, { force: true }).pipe(Effect.ignore),
    );
  });
