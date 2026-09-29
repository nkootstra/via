import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, FileSystem } from "effect";
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
