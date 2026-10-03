import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, FileSystem, Option } from "effect";
import { TestClock } from "effect/testing";
import { FileLockTimeoutError, withFileLock } from "./index.ts";

const START = Date.parse("2026-01-01T00:00:00Z");

const tempFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return `${yield* fs.makeTempDirectoryScoped()}/data.json`;
});

/**
 * Lets real time pass for pending file-system calls, then moves the test clock on by `by`. A
 * waiter tries the lock once per step however long it is: it sleeps again only once it has tried.
 */
const step = (by: Duration.Input = "50 millis") =>
  Effect.andThen(TestClock.withLive(Effect.sleep("2 millis")), TestClock.adjust(by));

/**
 * Moves the test clock forward a `step` of `by` at a time until `fiber` is done; `tick` runs
 * before each step.
 */
const advanceUntilDone = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  { tick = Effect.void, by }: { tick?: Effect.Effect<void>; by?: Duration.Input } = {},
) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* tick;
      yield* step(by);
    }

    return yield* Fiber.join(fiber);
  });

layer(BunFileSystem.layer)("withFileLock", (it) => {
  it.effect("runs the effect, then removes the lock file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile;

      const seen = yield* withFileLock(file, fs.exists(`${file}.lock`));

      expect(seen).toBe(true);
      expect(yield* fs.exists(`${file}.lock`)).toBe(false);
    }),
  );

  it.effect("removes the lock file when the effect fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile;

      yield* Effect.flip(withFileLock(file, Effect.fail("boom")));

      expect(yield* fs.exists(`${file}.lock`)).toBe(false);
    }),
  );

  it.effect("makes a second holder wait until the first releases the lock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const file = yield* tempFile;
      const events: Array<string> = [];
      const release = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();

      const first = yield* withFileLock(
        file,
        Effect.gen(function* () {
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(release);
          events.push("first");
        }),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(held);

      const second = yield* withFileLock(
        file,
        Effect.sync(() => events.push("second")),
      ).pipe(Effect.forkChild);

      yield* Effect.replicateEffect(step(), 20, { discard: true });

      expect(second.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* advanceUntilDone(second);
      expect(events).toEqual(["first", "second"]);
    }),
  );

  it.effect("keeps its lock from going stale for as long as the effect runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(START);
      const file = yield* tempFile;
      const events: Array<string> = [];
      const release = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();

      const first = yield* withFileLock(
        file,
        Effect.gen(function* () {
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(release);
          events.push("first");
        }),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(held);
      // Taken at the test clock's start rather than in real time, which is far ahead of it.
      const takenAt = new Date(START);
      yield* fs.utimes(`${file}.lock`, takenAt, takenAt);

      const second = yield* withFileLock(
        file,
        Effect.sync(() => events.push("second")),
      ).pipe(Effect.forkChild);

      // Well past the 5 s after which a lock no one renews counts as stale, yet short of the
      // 10 s after which the second gives up.
      yield* Effect.replicateEffect(step("1 second"), 8, { discard: true });
      // Lets a second that took the lock over finish with it.
      yield* TestClock.withLive(Effect.sleep("50 millis"));

      expect(events).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* advanceUntilDone(second);
      expect(events).toEqual(["first", "second"]);
    }),
  );

  it.effect("takes over a stale lock left behind by a crashed process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(START);
      const file = yield* tempFile;
      yield* fs.writeFileString(`${file}.lock`, "");
      const crashedAt = new Date(START - 60_000);
      yield* fs.utimes(`${file}.lock`, crashedAt, crashedAt);

      expect(yield* withFileLock(file, Effect.succeed("ran"))).toBe("ran");
    }),
  );

  it.effect("leaves the lock alone once another holder has taken it over as stale", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(START);
      const file = yield* tempFile;
      const lock = `${file}.lock`;
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const firstHeld = yield* Deferred.make<void>();
      const secondHeld = yield* Deferred.make<void>();

      const first = yield* withFileLock(
        file,
        Deferred.succeed(firstHeld, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(firstHeld);
      // The first holder stalled long enough for its lock to look abandoned.
      const stalledAt = new Date(START - 60_000);
      yield* fs.utimes(lock, stalledAt, stalledAt);

      const second = yield* withFileLock(
        file,
        Deferred.succeed(secondHeld, undefined).pipe(Effect.andThen(Deferred.await(releaseSecond))),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(secondHeld);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);

      expect(yield* fs.exists(lock)).toBe(true);
      yield* Deferred.succeed(releaseSecond, undefined);
      yield* Fiber.join(second);
      expect(yield* fs.exists(lock)).toBe(false);
    }),
  );

  it.effect("stops renewing a lock another holder has taken over", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(START);
      const file = yield* tempFile;
      const lock = `${file}.lock`;
      const release = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();

      const holder = yield* withFileLock(
        file,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(held);
      // Stands in for another process that judged the lock stale and took it over.
      yield* fs.writeFileString(lock, "someone-else");
      const takenAt = new Date(START - 60_000);
      yield* fs.utimes(lock, takenAt, takenAt);

      yield* Effect.replicateEffect(step("1 second"), 3, { discard: true });
      yield* TestClock.withLive(Effect.sleep("50 millis"));

      const info = yield* fs.stat(lock);
      expect(info.mtime.pipe(Option.map((mtime) => mtime.getTime()))).toEqual(
        Option.some(takenAt.getTime()),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(yield* fs.readFileString(lock)).toBe("someone-else");
    }),
  );

  it.effect("gives up with FileLockTimeoutError while another holder keeps the lock fresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(START);
      const file = yield* tempFile;
      const lock = `${file}.lock`;
      yield* fs.writeFileString(lock, "");

      // Stands in for a live holder that keeps the lock's mtime current.
      const touch = Effect.gen(function* () {
        const now = new Date(yield* Effect.clockWith((clock) => clock.currentTimeMillis));
        yield* fs.utimes(lock, now, now);
      }).pipe(Effect.orDie);

      yield* touch;
      const waiting = yield* withFileLock(file, Effect.void).pipe(Effect.flip, Effect.forkChild);
      // A second at a time, well inside the 5 s after which a lock counts as stale: the waiter
      // gives up after ten or so tries, not the two hundred that 50 ms steps take, each of them
      // file-system calls that a loaded machine slows down.
      const error = yield* advanceUntilDone(waiting, { tick: touch, by: "1 second" });

      expect(error).toEqual(new FileLockTimeoutError({ path: file }));
    }),
  );
});
