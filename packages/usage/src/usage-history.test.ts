import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import type { UsageEntry } from "./usage-history.ts";
import { UsageHistory } from "./usage-history.ts";

const HOUR = 60 * 60 * 1000;

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  requestId: "00000000-0000-4000-8000-000000000001",
  at: 1_000 * HOUR,
  status: 200,
  error: Option.none(),
  streamEnd: Option.none(),
  keyId: Option.some("key-1"),
  keyName: Option.some("laptop"),
  model: "gpt-6-astra",
  provider: "codex",
  accountId: Option.some("acc-1"),
  accountLabel: Option.some("a@example.com"),
  inputTokens: Option.some(100),
  cachedTokens: Option.some(40),
  outputTokens: Option.some(20),
  reasoningTokens: Option.none(),
  costUsd: Option.none(),
  durationMs: 1_200,
  firstChunkMs: Option.none(),
  ...overrides,
});

const history = <A, E>(body: (history: UsageHistory["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(UsageHistory, body).pipe(Effect.provide(UsageHistory.layerMemory));

describe("UsageHistory", () => {
  it.effect("gives back a recorded request as it was recorded", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry());
        const page = yield* usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 });
        expect(page.requests).toEqual([entry()]);
        expect(page.next).toEqual(Option.none());
      }),
    ),
  );

  it.effect("lists the newest requests first, a page at a time", () =>
    history((usage) =>
      Effect.gen(function* () {
        for (const hour of [1, 2, 3]) {
          yield* usage.record(entry({ requestId: `r${hour}`, at: hour * HOUR }));
        }

        const first = yield* usage.requests({ from: 0, to: 10 * HOUR, limit: 2 });
        expect(first.requests.map((r) => r.requestId)).toEqual(["r3", "r2"]);
        expect(Option.isSome(first.next)).toBe(true);

        const second = yield* usage.requests({
          from: 0,
          to: 10 * HOUR,
          limit: 2,
          cursor: Option.getOrUndefined(first.next),
        });

        expect(second.requests.map((r) => r.requestId)).toEqual(["r1"]);
        expect(second.next).toEqual(Option.none());
      }),
    ),
  );

  it.effect("pages past requests that share a timestamp without skipping any", () =>
    history((usage) =>
      Effect.gen(function* () {
        for (const id of ["a", "b", "c"]) yield* usage.record(entry({ requestId: id, at: HOUR }));

        const first = yield* usage.requests({ from: 0, to: 2 * HOUR, limit: 2 });

        const second = yield* usage.requests({
          from: 0,
          to: 2 * HOUR,
          limit: 2,
          cursor: Option.getOrUndefined(first.next),
        });

        expect([...first.requests, ...second.requests].map((r) => r.requestId).toSorted()).toEqual([
          "a",
          "b",
          "c",
        ]);
      }),
    ),
  );

  it.effect("lists only requests in the range and matching the filters", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry({ requestId: "early", at: 1 * HOUR }));
        yield* usage.record(
          entry({ requestId: "other-key", at: 5 * HOUR, keyId: Option.some("k2") }),
        );
        yield* usage.record(entry({ requestId: "failed", at: 5 * HOUR, status: 429 }));
        yield* usage.record(entry({ requestId: "match", at: 5 * HOUR }));

        const page = yield* usage.requests({
          from: 2 * HOUR,
          to: 10 * HOUR,
          limit: 10,
          keyId: "key-1",
          model: "gpt-6-astra",
          accountId: "acc-1",
          outcome: "ok",
        });

        expect(page.requests.map((r) => r.requestId)).toEqual(["match"]);

        const failed = yield* usage.requests({
          from: 0,
          to: 10 * HOUR,
          limit: 10,
          outcome: "error",
        });

        expect(failed.requests.map((r) => r.requestId)).toEqual(["failed"]);
      }),
    ),
  );
});
