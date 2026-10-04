import {
  Clock,
  Data,
  type Duration,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Random,
  Schedule,
  Schema,
} from "effect";
import { dirname } from "node:path";

// A holder renews its lock every second for as long as it holds it, so a lock this old was
// left by a process that died holding it. Taking it over has a narrow race (two waiters can
// both judge it stale and both proceed), which is accepted: it needs a crash first.
const STALE_AFTER_MS = 5_000;

const RENEW_EVERY = "1 second";

// Longer than STALE_AFTER_MS, so a crashed holder's lock is taken over before a waiter gives up.
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

/** Identifies one holder, so it acts only on a lock file it still owns. */
const makeToken = Effect.gen(function* () {
  const parts = yield* Effect.replicateEffect(Random.nextInt, 4);

  return parts.map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
});

/** Creates the lock file holding `token` if no one holds it; whether it did. */
const tryCreate = (fs: FileSystem.FileSystem, lock: string, token: string) =>
  fs.writeFileString(lock, token, { flag: "wx", mode: 0o600 }).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
  );

/** Whether `lock` still holds `token`, that is, no other holder has taken it over as stale. */
const owns = (fs: FileSystem.FileSystem, lock: string, token: string) =>
  fs.readFileString(lock).pipe(
    Effect.map((text) => text === token),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
  );

const acquire = (path: string, lock: string, token: string, giveUpAfter: Duration.Input) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (yield* tryCreate(fs, lock, token)) return;
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

      if (yield* tryCreate(fs, lock, token)) return;
    }

    return yield* new LockBusy();
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: giveUpAfter })),
      while: Predicate.isTagged("LockBusy"),
    }),
    Effect.catchTag("LockBusy", () => Effect.fail(new FileLockTimeoutError({ path }))),
  );

/**
 * Keeps `lock` from going stale, touching it every second until interrupted, but only while it
 * still holds `token`: a lock taken over as stale belongs to its new holder.
 */
const renew = (fs: FileSystem.FileSystem, lock: string, token: string) =>
  Effect.gen(function* () {
    if (!(yield* owns(fs, lock, token))) return;
    const now = new Date(yield* Clock.currentTimeMillis);
    yield* fs.utimes(lock, now, now);
  }).pipe(
    // A missed renewal only brings a takeover closer; the next one may succeed.
    Effect.ignore,
    Effect.delay(RENEW_EVERY),
    Effect.forever,
  );

/**
 * Runs `effect` while holding an exclusive lock on `path`, shared with every other process
 * that locks it: a `<path>.lock` file holding a random owner token, created with O_EXCL,
 * renewed while `effect` runs and removed afterwards, each only while the file still holds that
 * token. Checking the token and then acting isn't atomic; like a takeover, that race needs a
 * stalled holder first. Guards a read-modify-write of `path` against another via process (the
 * CLI next to `via serve`). A waiter gives up after ten seconds, or `giveUpAfter` when the
 * lock guards something that takes longer.
 */
export const withFileLock = <A, E, R>(
  path: string,
  effect: Effect.Effect<A, E, R>,
  { giveUpAfter = GIVE_UP_AFTER }: { readonly giveUpAfter?: Duration.Input } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = `${path}.lock`;
    const token = yield* makeToken;
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });

    return yield* Effect.acquireUseRelease(
      acquire(path, lock, token, giveUpAfter),
      () => Effect.raceFirst(effect, renew(fs, lock, token)),
      () =>
        Effect.gen(function* () {
          if (yield* owns(fs, lock, token)) yield* fs.remove(lock, { force: true });
        }).pipe(Effect.ignore),
    );
  });
