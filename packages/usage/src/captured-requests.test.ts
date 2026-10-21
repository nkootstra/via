import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, FileSystem, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { CapturedRequests } from "./captured-requests.ts";
import type { CapturedRequest } from "./entry.ts";

const DAY = 24 * 60 * 60 * 1000;

const captured = (overrides: Partial<CapturedRequest> = {}): CapturedRequest => ({
  requestId: "r1",
  capturedAt: 10 * DAY,
  endpoint: "chat/completions",
  request: { model: "gpt-6", messages: [{ role: "user", content: "hello" }] },
  upstreamErrors: [
    { seq: 0, status: 429, body: { error: { code: "rate_limit_exceeded" } } },
    { seq: 1, status: null, body: "upstream went away" },
  ],
  redactions: [{ kind: "openai-key", count: 1 }],
  truncated: false,
  sizeBytes: 64,
  ...overrides,
});

const store = <A, E>(body: (requests: CapturedRequests["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(CapturedRequests, body).pipe(Effect.provide(CapturedRequests.layerMemory));

/** `store` with the clock already at `now`, so its prune doesn't catch up. */
const storeAt = <A, E>(
  now: number,
  body: (requests: CapturedRequests["Service"]) => Effect.Effect<A, E>,
) => Effect.andThen(TestClock.setTime(now), store(body));

describe("CapturedRequests", () => {
  it.effect("gives back a captured request as it was kept", () =>
    store((requests) =>
      Effect.gen(function* () {
        yield* requests.keep(captured());

        expect(yield* requests.get("r1")).toEqual(Option.some(captured()));
        expect(yield* requests.get("r2")).toEqual(Option.none());
      }),
    ),
  );

  it.effect("gives back the latest of requests that share an id", () =>
    store((requests) =>
      Effect.gen(function* () {
        yield* requests.keep(captured({ capturedAt: 1 }));
        yield* requests.keep(captured({ capturedAt: 2, endpoint: "responses" }));

        expect(yield* requests.get("r1")).toEqual(
          Option.some(captured({ capturedAt: 2, endpoint: "responses" })),
        );
      }),
    ),
  );

  it.effect("says which of some requests it has", () =>
    store((requests) =>
      Effect.gen(function* () {
        yield* requests.keep(captured({ requestId: "a" }));
        yield* requests.keep(captured({ requestId: "c" }));

        expect(yield* requests.which(["a", "b", "c"])).toEqual(["a", "c"]);
        expect(yield* requests.which([])).toEqual([]);
      }),
    ),
  );

  it.effect("forgets every request it cleared, and says how many", () =>
    store((requests) =>
      Effect.gen(function* () {
        yield* requests.keep(captured({ requestId: "a" }));
        yield* requests.keep(captured({ requestId: "b" }));

        expect(yield* requests.clear).toBe(2);
        expect(yield* requests.which(["a", "b"])).toEqual([]);
      }),
    ),
  );

  it.effect("signals at once, then after each request kept and each clear", () =>
    store((requests) =>
      Effect.gen(function* () {
        const seen = yield* requests.changes.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Effect.yieldNow;
        yield* requests.keep(captured());
        yield* requests.clear;

        expect(yield* Fiber.join(seen)).toHaveLength(3);
      }),
    ),
  );
});

describe("CapturedRequests retention", () => {
  it.effect("forgets requests captured more than 7 days ago, and only those", () => {
    const now = 100 * DAY;

    return storeAt(now, (requests) =>
      Effect.gen(function* () {
        yield* requests.keep(captured({ requestId: "old", capturedAt: now - 7 * DAY - 1 }));
        yield* requests.keep(captured({ requestId: "edge", capturedAt: now - 7 * DAY }));
        yield* requests.keep(captured({ requestId: "new", capturedAt: now - DAY }));

        yield* requests.prune;

        expect(yield* requests.which(["old", "edge", "new"])).toEqual(["edge", "new"]);
      }),
    );
  });

  it.effect("prunes every hour while it runs", () =>
    Effect.gen(function* () {
      const requests = yield* CapturedRequests;
      yield* requests.keep(captured({ capturedAt: 0 }));
      yield* TestClock.adjust(Duration.days(7));
      expect(yield* requests.which(["r1"])).toEqual(["r1"]);

      yield* TestClock.adjust(Duration.hours(1));
      expect(yield* requests.which(["r1"])).toEqual([]);
    }).pipe(Effect.provide(CapturedRequests.layerMemory)),
  );
});

layer(BunFileSystem.layer)("CapturedRequests file", (withFs) => {
  withFs.effect("keeps the database readable by its owner only, and across a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = `${yield* fs.makeTempDirectoryScoped()}/nested/bodies.db`;
      const open = CapturedRequests.layer(path);

      yield* Effect.flatMap(CapturedRequests, (requests) => requests.keep(captured())).pipe(
        Effect.provide(open),
      );

      expect(((yield* fs.stat(path)).mode & 0o777).toString(8)).toBe("600");

      const found = yield* Effect.flatMap(CapturedRequests, (requests) => requests.get("r1")).pipe(
        Effect.provide(open),
      );

      expect(found).toEqual(Option.some(captured()));
    }),
  );
});
