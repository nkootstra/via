import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Arbitrary } from "effect/unstable/arbitrary";
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

describe("UsageHistory.series", () => {
  it.effect("sums each hour's tokens per model", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry({ requestId: "a", at: 10 * HOUR + 5 }));
        yield* usage.record(entry({ requestId: "b", at: 10 * HOUR + 50 }));
        yield* usage.record(entry({ requestId: "c", at: 10 * HOUR + 9, model: "gpt-6-sol" }));
        yield* usage.record(entry({ requestId: "d", at: 11 * HOUR, inputTokens: Option.none() }));

        const points = yield* usage.series({
          from: 0,
          to: 24 * HOUR,
          bucket: "hour",
          tzOffsetMinutes: 0,
          groupBy: "model",
        });

        expect(points).toEqual([
          {
            bucket: 10 * HOUR,
            group: "gpt-6-astra",
            requests: 2,
            measured: 2,
            inputTokens: 200,
            cachedTokens: 80,
            outputTokens: 40,
            reasoningTokens: 0,
          },
          {
            bucket: 10 * HOUR,
            group: "gpt-6-sol",
            requests: 1,
            measured: 1,
            inputTokens: 100,
            cachedTokens: 40,
            outputTokens: 20,
            reasoningTokens: 0,
          },
          {
            bucket: 11 * HOUR,
            group: "gpt-6-astra",
            requests: 1,
            measured: 0,
            inputTokens: 0,
            cachedTokens: 40,
            outputTokens: 20,
            reasoningTokens: 0,
          },
        ]);
      }),
    ),
  );

  it.effect("starts each day at local midnight", () =>
    history((usage) =>
      Effect.gen(function* () {
        const midnight = 1_000 * 24 * HOUR;
        // 23:30 UTC is already the next day an hour east of UTC.
        yield* usage.record(entry({ at: midnight - HOUR / 2 }));

        const points = yield* usage.series({
          from: 0,
          to: 2 * midnight,
          bucket: "day",
          tzOffsetMinutes: 60,
          groupBy: "model",
        });

        expect(points.map((p) => p.bucket)).toEqual([midnight - HOUR]);
      }),
    ),
  );

  it.effect("groups by account, filing a request no account served under its provider", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry({ requestId: "a" }));

        yield* usage.record(
          entry({
            requestId: "b",
            provider: "openrouter",
            accountId: Option.none(),
            accountLabel: Option.none(),
          }),
        );

        const points = yield* usage.series({
          from: 0,
          to: 2_000 * HOUR,
          bucket: "day",
          tzOffsetMinutes: 0,
          groupBy: "account",
        });

        expect(points.map((p) => p.group).toSorted()).toEqual(["acc-1", "provider:openrouter"]);
      }),
    ),
  );
});

describe("UsageHistory.breakdown", () => {
  it.effect("totals each group, labelled as its latest request was", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry({ requestId: "a", at: HOUR, keyName: Option.some("old") }));
        yield* usage.record(entry({ requestId: "b", at: 2 * HOUR, keyName: Option.some("new") }));
        yield* usage.record(entry({ requestId: "c", at: 3 * HOUR, status: 429 }));
        yield* usage.record(entry({ requestId: "d", at: 4 * HOUR, status: 499 }));

        yield* usage.record(
          entry({ requestId: "e", at: 5 * HOUR, streamEnd: Option.some("failed") }),
        );

        const { groups } = yield* usage.breakdown({ from: 0, to: 10 * HOUR, groupBy: "key" });

        expect(groups).toEqual([
          {
            group: "key-1",
            label: "laptop",
            requests: 5,
            errors: 2,
            measured: 5,
            inputTokens: 500,
            cachedTokens: 200,
            outputTokens: 100,
            reasoningTokens: 0,
            firstChunkMs: { p50: Option.none(), p95: Option.none() },
            models: [
              {
                model: "gpt-6-astra",
                billedUsd: 0,
                billedRequests: 0,
                unbilled: { inputTokens: 500, cachedTokens: 200, outputTokens: 100 },
              },
            ],
          },
        ]);
      }),
    ),
  );

  it.effect("splits what an upstream billed from what via has to price itself", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry({ requestId: "a", costUsd: Option.some(0.25) }));
        yield* usage.record(entry({ requestId: "b", costUsd: Option.some(0.5) }));
        yield* usage.record(entry({ requestId: "c" }));

        const { groups } = yield* usage.breakdown({
          from: 0,
          to: 2_000 * HOUR,
          groupBy: "model",
        });

        expect(groups[0]?.models).toEqual([
          {
            model: "gpt-6-astra",
            billedUsd: 0.75,
            billedRequests: 2,
            unbilled: { inputTokens: 100, cachedTokens: 40, outputTokens: 20 },
          },
        ]);
      }),
    ),
  );

  it.effect("gives the median and 95th percentile time to the first chunk, by nearest rank", () =>
    history((usage) =>
      Effect.gen(function* () {
        for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 1_000]) {
          yield* usage.record(entry({ requestId: `r${ms}`, firstChunkMs: Option.some(ms) }));
        }

        yield* usage.record(entry({ requestId: "none" }));

        const result = yield* usage.breakdown({ from: 0, to: 2_000 * HOUR, groupBy: "model" });
        const expected = { p50: Option.some(50), p95: Option.some(1_000) };

        expect(result.groups[0]?.firstChunkMs).toEqual(expected);
        expect(result.firstChunkMs).toEqual(expected);
      }),
    ),
  );
});

/** A request, in small ranges so that property runs share hours, models and keys. */
const Spec = Schema.Struct({
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 71 })),
  model: Schema.Literals(["m1", "m2", "m3"]),
  key: Schema.Literals(["k1", "k2"]),
  account: Schema.Literals(["a1", "a2", "none"]),
  tokens: Schema.OptionFromNullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })),
  ),
  status: Schema.Literals([200, 429, 499, 500]),
});

const toEntry = (spec: typeof Spec.Type, i: number) =>
  entry({
    requestId: `r${i}`,
    at: spec.hour * HOUR + i,
    model: spec.model,
    keyId: Option.some(spec.key),
    accountId: spec.account === "none" ? Option.none() : Option.some(spec.account),
    provider: spec.account === "none" ? "openrouter" : "codex",
    inputTokens: spec.tokens,
    cachedTokens: spec.tokens,
    outputTokens: spec.tokens,
    reasoningTokens: spec.tokens,
    status: spec.status,
  });

const specs = Arbitrary.array(Arbitrary.schema(Spec), { maxLength: 30 });

const groupings = Arbitrary.schema(Schema.Literals(["model", "account", "key", "provider"]));

const buckets = Arbitrary.schema(Schema.Literals(["hour", "day"]));

const offsets = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ minimum: -720, maximum: 840 })),
);

const sum = (values: ReadonlyArray<number>) => values.reduce((a, b) => a + b, 0);

describe("UsageHistory totals", () => {
  it.effect.prop(
    "the series and the breakdown both add up to every request's tokens, however they group",
    { specs, groupBy: groupings, bucket: buckets, tzOffsetMinutes: offsets },
    ({ specs: values, groupBy, bucket, tzOffsetMinutes }) =>
      history((usage) =>
        Effect.gen(function* () {
          const entries = values.map(toEntry);
          yield* Effect.forEach(entries, usage.record, { discard: true });
          const range = { from: 0, to: 72 * HOUR };
          const points = yield* usage.series({ ...range, bucket, tzOffsetMinutes, groupBy });
          const { groups } = yield* usage.breakdown({ ...range, groupBy });
          const tokens = sum(entries.map((e) => Option.getOrElse(e.inputTokens, () => 0)));

          expect(sum(points.map((p) => p.inputTokens))).toBe(tokens);
          expect(sum(groups.map((g) => g.inputTokens))).toBe(tokens);
          expect(sum(points.map((p) => p.requests))).toBe(entries.length);
          expect(sum(groups.map((g) => g.requests))).toBe(entries.length);

          expect(sum(groups.map((g) => g.errors))).toBe(
            entries.filter((e) => e.status >= 400 && e.status !== 499).length,
          );
        }),
      ),
  );

  it.effect.prop(
    "a bucket never holds a request from outside it",
    { specs, bucket: buckets, tzOffsetMinutes: offsets },
    ({ specs: values, bucket, tzOffsetMinutes }) =>
      history((usage) =>
        Effect.gen(function* () {
          const entries = values.map(toEntry);
          yield* Effect.forEach(entries, usage.record, { discard: true });

          const points = yield* usage.series({
            from: 0,
            to: 72 * HOUR,
            bucket,
            tzOffsetMinutes,
            groupBy: "model",
          });

          const size = bucket === "hour" ? HOUR : 24 * HOUR;

          for (const point of points) {
            const inside = entries.filter(
              (e) => e.model === point.group && e.at >= point.bucket && e.at < point.bucket + size,
            );

            expect(inside.length).toBe(point.requests);
          }
        }),
      ),
  );
});

const DAY = 24 * HOUR;

describe("UsageHistory retention", () => {
  it.effect("forgets requests older than 90 days, and only those", () =>
    history((usage) =>
      Effect.gen(function* () {
        const now = 200 * DAY;
        yield* TestClock.setTime(now);
        yield* usage.record(entry({ requestId: "old", at: now - 90 * DAY - 1 }));
        yield* usage.record(entry({ requestId: "edge", at: now - 90 * DAY }));
        yield* usage.record(entry({ requestId: "new", at: now - DAY }));

        yield* usage.prune;

        const page = yield* usage.requests({ from: 0, to: now, limit: 10 });
        expect(page.requests.map((r) => r.requestId)).toEqual(["new", "edge"]);
      }),
    ),
  );

  it.effect.prop(
    "pruning never forgets a request from the last 90 days",
    {
      ages: Arbitrary.array(
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
        { maxLength: 20 },
      ),
    },
    ({ ages }) =>
      history((usage) =>
        Effect.gen(function* () {
          const now = 400 * DAY;
          yield* TestClock.setTime(now);

          yield* Effect.forEach(
            ages,
            (age, i) => usage.record(entry({ requestId: `r${i}`, at: now - age * DAY })),
            { discard: true },
          );

          yield* usage.prune;

          const page = yield* usage.requests({ from: 0, to: now + 1, limit: 1_000 });
          expect(page.requests.length).toBe(ages.filter((age) => age <= 90).length);
        }),
      ),
  );

  it.effect("prunes once a day while it runs", () =>
    Effect.gen(function* () {
      const usage = yield* UsageHistory;
      yield* usage.record(entry({ requestId: "old", at: 0 }));
      yield* TestClock.adjust(Duration.days(89));
      expect((yield* usage.requests({ from: 0, to: 1, limit: 1 })).requests).toHaveLength(1);

      yield* TestClock.adjust(Duration.days(2));
      expect((yield* usage.requests({ from: 0, to: 1, limit: 1 })).requests).toHaveLength(0);
    }).pipe(Effect.provide(UsageHistory.layerMemory)),
  );
});

layer(BunFileSystem.layer)("UsageHistory file", (withFs) => {
  withFs.effect("keeps the database readable by its owner only, and across a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = `${yield* fs.makeTempDirectoryScoped()}/nested/usage.db`;
      const open = UsageHistory.layer(path);

      yield* Effect.flatMap(UsageHistory, (usage) => usage.record(entry())).pipe(
        Effect.provide(open),
      );

      expect(((yield* fs.stat(path)).mode & 0o777).toString(8)).toBe("600");

      const page = yield* Effect.flatMap(UsageHistory, (usage) =>
        usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 }),
      ).pipe(Effect.provide(open));

      expect(page.requests).toEqual([entry()]);
    }),
  );
});
