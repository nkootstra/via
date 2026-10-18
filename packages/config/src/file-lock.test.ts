import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer, Stream, Exit } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { dirname } from "node:path";
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
  it.effect("creates an owner-only lock database and releases the lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile;
      expect(yield* withFileLock(file, Effect.succeed("ran"))).toBe("ran");
      expect((yield* fs.stat(`${file}.lock.db`)).mode & 0o777).toBe(0o600);
      expect(yield* withFileLock(file, Effect.succeed("again"))).toBe("again");
    }),
  );

  it.effect("releases the lock when the effect fails", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      expect(yield* Effect.exit(withFileLock(file, Effect.fail("boom")))).toEqual(
        Exit.fail("boom"),
      );
      expect(yield* withFileLock(file, Effect.succeed("again"))).toBe("again");
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

  it.effect("keeps a live holder exclusive after its lock timestamp changes", () =>
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
      yield* fs.utimes(`${file}.lock.db`, takenAt, takenAt);

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

  it.effect("releases the lock when its holder is interrupted", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const held = yield* Deferred.make<void>();

      const holder = yield* withFileLock(
        file,
        Effect.andThen(Deferred.succeed(held, undefined), Effect.never),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(held);
      yield* Fiber.interrupt(holder);
      expect(yield* withFileLock(file, Effect.succeed("again"))).toBe("again");
    }),
  );

  it.effect("does not run a waiter interrupted before its holder releases", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const holder = yield* withFileLock(
        file,
        Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release)),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(held);
      let ran = false;

      const waiting = yield* withFileLock(
        file,
        Effect.sync(() => {
          ran = true;
        }),
      ).pipe(Effect.forkChild);

      yield* Effect.replicateEffect(step(), 2, { discard: true });
      yield* Fiber.interrupt(waiting);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(ran).toBe(false);
    }),
  );

  it.effect("gives up with FileLockTimeoutError while another holder is alive", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const held = yield* Deferred.make<void>();

      const holder = yield* withFileLock(
        file,
        Effect.andThen(Deferred.succeed(held, undefined), Effect.never),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(held);
      const waiting = yield* withFileLock(file, Effect.void).pipe(Effect.flip, Effect.forkChild);
      expect(yield* advanceUntilDone(waiting, { by: "1 second" })).toEqual(
        new FileLockTimeoutError({ path: file }),
      );
      yield* Fiber.interrupt(holder);
    }),
  );

  it.effect("waits for a holder past ten seconds when given a longer deadline", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const holder = yield* withFileLock(
        file,
        Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release)),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(held);

      const waiting = yield* withFileLock(file, Effect.succeed("ran"), {
        giveUpAfter: "3 minutes",
      }).pipe(Effect.forkChild);

      yield* Effect.replicateEffect(step("1 second"), 15, { discard: true });
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(yield* advanceUntilDone(waiting)).toBe("ran");
    }),
  );
});

layer(
  Layer.mergeAll(
    BunFileSystem.layer,
    BunChildProcessSpawner.layer.pipe(Layer.provide([BunFileSystem.layer, BunPath.layer])),
  ),
)("process locks", (it) => {
  it.effect("keeps a paused holder exclusive even when its lock timestamp is old", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* tempFile;

        const child = yield* ChildProcess.make(
          process.execPath,
          [
            "-e",
            `
        import { Effect, Console } from "effect";
        import { BunFileSystem } from "@effect/platform-bun";
        import { withFileLock } from "./src/index.ts";
        await Effect.runPromise(withFileLock(process.argv[1],
          Effect.andThen(Console.log("held"), Effect.sleep("1 day"))
        ).pipe(Effect.provide(BunFileSystem.layer)));
      `,
            file,
          ],
          { cwd: new URL("..", import.meta.url).pathname },
        );

        // SIGSTOP prevents graceful exit; the finalizer must also work if an assertion fails.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (yield* child.isRunning) yield* child.kill({ killSignal: "SIGKILL" });
          }).pipe(Effect.orDie),
        );
        expect(
          yield* child.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.take(1),
            Stream.runCollect,
          ),
        ).toEqual(["held"]);
        yield* Effect.sync(() => process.kill(child.pid, "SIGSTOP"));
        const old = new Date(0);

        for (const name of yield* fs.readDirectory(dirname(file))) {
          if (name.startsWith("data.json.lock"))
            yield* fs.utimes(`${dirname(file)}/${name}`, old, old);
        }

        const outcome = yield* Effect.exit(
          withFileLock(file, Effect.succeed("entered"), { giveUpAfter: "100 millis" }),
        );

        expect(outcome).toEqual(Exit.fail(new FileLockTimeoutError({ path: file })));
        yield* child.kill({ killSignal: "SIGKILL" });
        yield* Effect.exit(child.exitCode);
        expect(yield* withFileLock(file, Effect.succeed("recovered"))).toBe("recovered");
      }),
    ),
  );
});
