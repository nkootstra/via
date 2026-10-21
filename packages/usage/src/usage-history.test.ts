import { BunFileSystem } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SqlClient } from "effect/sql";
import { describe, expect, it, layer } from "@effect/vitest";
import {
  Arbitrary,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Predicate,
  Schema,
  Stream,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import type { UsageEntry } from "./entry.ts";
import { UsageHistory } from "./usage-history.ts";

const HOUR = 60 * 60 * 1000;

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  requestId: "00000000-0000-4000-8000-000000000001",
  at: 1_000 * HOUR,
  status: 200,
  error: Option.none(),
  errorMessage: Option.none(),
  streamEnd: Option.none(),
  keyId: Option.some("key-1"),
  keyName: Option.some("laptop"),
  model: "gpt-6-astra",
  provider: "codex",
  accountId: Option.some("acc-1"),
  accountLabel: Option.some("a@example.com"),
  inputTokens: Option.some(100),
  cachedTokens: Option.some(40),
  cacheWriteTokens: Option.none(),
  outputTokens: Option.some(20),
  reasoningTokens: Option.none(),
  costUsd: Option.none(),
  durationMs: 1_200,
  firstChunkMs: Option.none(),
  requestedModel: Option.none(),
  fallbackReason: Option.none(),
  conversationId: Option.none(),
  parentConversationId: Option.none(),
  sessionSource: Option.none(),
  agentType: Option.none(),
  client: Option.none(),
  ...overrides,
});

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const history = <A, E>(body: (history: UsageHistory["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(UsageHistory, body).pipe(Effect.provide(UsageHistory.layerMemory));

/**
 * `history` with the clock already at `now`. Moving the clock ahead after the
 * history has started would make its daily prune catch up a run for every day.
 */
const historyAt = <A, E>(
  now: number,
  body: (history: UsageHistory["Service"]) => Effect.Effect<A, E>,
) => Effect.andThen(TestClock.setTime(now), history(body));

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

  it.effect("gives back the model a request asked for when another served it, and why", () =>
    history((usage) =>
      Effect.gen(function* () {
        const fellBack = entry({
          model: "opencode-go/kimi-k3",
          provider: "opencode-go",
          requestedModel: Option.some("gpt-5.6-sol-high"),
          fallbackReason: Option.some("rate_limit_exceeded"),
        });

        yield* usage.record(fellBack);
        const page = yield* usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 });
        expect(page.requests).toEqual([fellBack]);
      }),
    ),
  );

  it.effect("gives back the conversation a request belongs to, and the client that sent it", () =>
    history((usage) =>
      Effect.gen(function* () {
        const subAgent = entry({
          conversationId: Option.some("t2"),
          parentConversationId: Option.some("t1"),
          sessionSource: Option.some("thread-id"),
          agentType: Option.some("review"),
          client: Option.some("codex_cli_rs/0.40.0"),
        });

        yield* usage.record(subAgent);
        const page = yield* usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 });
        expect(page.requests).toEqual([subAgent]);
      }),
    ),
  );

  it.effect("gives back why a request failed, in a code and in words", () =>
    history((usage) =>
      Effect.gen(function* () {
        const failed = entry({
          status: 400,
          error: Option.some("ModelProtocolUnsupported"),
          errorMessage: Option.some("Model does not support this protocol."),
        });

        yield* usage.record(failed);
        const page = yield* usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 });
        expect(page.requests).toEqual([failed]);
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

/** The buckets of requests at each of `times`, in `zone`. */
const bucketsAt = (zone: string, bucket: "hour" | "day", times: ReadonlyArray<string>) =>
  history((usage) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        times,
        (time, i) => usage.record(entry({ requestId: `r${i}`, at: Date.parse(time) })),
        { discard: true },
      );

      const points = yield* usage.series({
        from: 0,
        to: Date.parse("2030-01-01T00:00:00Z"),
        bucket,
        timeZone: DateTime.zoneMakeNamedUnsafe(zone),
        groupBy: "model",
      });

      return points.map((p) => new Date(p.bucket).toISOString());
    }),
  );

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
          timeZone: utc,
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

  it.effect("starts each day at local midnight across a change to summer time", () =>
    Effect.gen(function* () {
      // Amsterdam moves from UTC+1 to UTC+2 at 02:00 on 29 March 2026: that day has 23 hours.
      const days = yield* bucketsAt("Europe/Amsterdam", "day", [
        "2026-03-28T23:30:00Z",
        "2026-03-29T12:00:00Z",
        "2026-03-29T22:30:00Z",
      ]);

      expect(days).toEqual(["2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"]);
    }),
  );

  it.effect("starts each day at local midnight across a change back from summer time", () =>
    Effect.gen(function* () {
      // Amsterdam moves from UTC+2 back to UTC+1 at 03:00 on 25 October 2026: that day has 25 hours.
      const days = yield* bucketsAt("Europe/Amsterdam", "day", [
        "2026-10-24T22:30:00Z",
        "2026-10-25T22:30:00Z",
        "2026-10-25T23:30:00Z",
      ]);

      expect(days).toEqual(["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]);
    }),
  );

  it.effect("keeps the hour that repeats when summer time ends apart from the first", () =>
    Effect.gen(function* () {
      // 00:30 and 01:30 UTC are both 02:30 in Amsterdam on 25 October 2026.
      const hours = yield* bucketsAt("Europe/Amsterdam", "hour", [
        "2026-10-25T00:30:00Z",
        "2026-10-25T01:30:00Z",
      ]);

      expect(hours).toEqual(["2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z"]);
    }),
  );

  it.effect("starts days and hours on the half hour in a zone half an hour off", () =>
    Effect.gen(function* () {
      // Adelaide moves from UTC+9:30 to UTC+10:30 at 02:00 on 4 October 2026.
      const days = yield* bucketsAt("Australia/Adelaide", "day", [
        "2026-10-03T15:00:00Z",
        "2026-10-04T14:00:00Z",
      ]);

      const hours = yield* bucketsAt("Asia/Kolkata", "hour", ["2026-10-04T10:15:00Z"]);

      expect(days).toEqual(["2026-10-03T14:30:00.000Z", "2026-10-04T13:30:00.000Z"]);
      expect(hours).toEqual(["2026-10-04T09:30:00.000Z"]);
    }),
  );

  it.effect("starts the hours on the hour again after the clocks move half an hour", () =>
    Effect.gen(function* () {
      // Lord Howe Island moves from UTC+10:30 to UTC+11 at 02:00 on 4 October 2026,
      // so its clocks skip from 02:00 to 02:30 and the next hour starts at 03:00.
      const hours = yield* bucketsAt("Australia/Lord_Howe", "hour", [
        "2026-10-03T14:45:00Z",
        "2026-10-03T15:45:00Z",
        "2026-10-03T16:15:00Z",
      ]);

      expect(hours).toEqual([
        "2026-10-03T14:30:00.000Z",
        "2026-10-03T15:30:00.000Z",
        "2026-10-03T16:00:00.000Z",
      ]);
    }),
  );

  it.effect("reads the series in a single pass over the requests", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry());
        const spans: Array<Tracer.NativeSpan> = [];

        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);

            return span;
          },
        });

        yield* usage
          .series({ from: 0, to: 2_000 * HOUR, bucket: "hour", timeZone: utc, groupBy: "model" })
          .pipe(Effect.withTracer(tracer));

        const statements = spans.flatMap((span) => {
          const text = span.attributes.get("db.query.text");

          return Predicate.isString(text) ? [text] : [];
        });

        // One statement, so a request recorded meanwhile can't fall outside the buckets, and
        // no join: matching each request against a list of buckets costs requests × buckets.
        expect(statements).toHaveLength(1);
        expect(statements[0]).not.toMatch(/JOIN|json_each/i);
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
          timeZone: utc,
          groupBy: "account",
        });

        expect(points.map((p) => p.group).toSorted()).toEqual(["acc-1", "provider:openrouter"]);
      }),
    ),
  );
});

/** Requests across two models, two keys, a failure, and a provider no account served. */
const filterTraffic = (usage: UsageHistory["Service"]) =>
  Effect.forEach(
    [
      entry({ requestId: "a", model: "m1", keyId: Option.some("k1") }),
      entry({ requestId: "b", model: "m2", keyId: Option.some("k1"), status: 429 }),
      entry({ requestId: "c", model: "m1", keyId: Option.some("k2") }),
      entry({
        requestId: "d",
        model: "m1",
        keyId: Option.some("k1"),
        provider: "openrouter",
        accountId: Option.none(),
        accountLabel: Option.none(),
      }),
    ],
    usage.record,
    { discard: true },
  );

describe("UsageHistory filters", () => {
  const range = { from: 0, to: 2_000 * HOUR };

  it.effect("narrow the series and the breakdown as they narrow the request list", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* filterTraffic(usage);
        const filters = { model: "m1", keyId: "k1" };

        const points = yield* usage.series({
          ...range,
          ...filters,
          bucket: "day",
          timeZone: utc,
          groupBy: "model",
        });

        const { groups } = yield* usage.breakdown({ ...range, ...filters, groupBy: "key" });
        const page = yield* usage.requests({ ...range, ...filters, limit: 10 });

        expect(points.map((p) => [p.group, p.requests])).toEqual([["m1", 2]]);
        expect(groups.map((g) => [g.group, g.requests])).toEqual([["k1", 2]]);
        expect(page.requests.map((r) => r.requestId).toSorted()).toEqual(["a", "d"]);
      }),
    ),
  );

  it.effect("keep only failed requests when asked", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* filterTraffic(usage);
        const { groups } = yield* usage.breakdown({ ...range, outcome: "error", groupBy: "model" });

        expect(groups.map((g) => [g.group, g.requests, g.errors])).toEqual([["m2", 1, 1]]);
      }),
    ),
  );

  it.effect("keep only requests that fell back when asked, and count them", () =>
    history((usage) =>
      Effect.gen(function* () {
        const fellBack = {
          requestedModel: Option.some("gpt-x"),
          fallbackReason: Option.some("rate_limit_exceeded"),
        };

        yield* Effect.forEach(
          [
            entry({ requestId: "a", model: "m1", ...fellBack }),
            entry({ requestId: "b", model: "m1" }),
            entry({ requestId: "c", model: "m2", ...fellBack }),
          ],
          usage.record,
          { discard: true },
        );

        const page = yield* usage.requests({ ...range, fellBack: true, limit: 10 });
        const all = yield* usage.breakdown({ ...range, groupBy: "model" });
        const only = yield* usage.breakdown({ ...range, fellBack: true, groupBy: "model" });

        expect(page.requests.map((r) => r.requestId).toSorted()).toEqual(["a", "c"]);
        expect(all.groups.map((g) => [g.group, g.requests, g.fellBack])).toEqual([
          ["m1", 2, 1],
          ["m2", 1, 1],
        ]);
        expect(only.groups.map((g) => [g.group, g.requests])).toEqual([
          ["m1", 1],
          ["m2", 1],
        ]);
      }),
    ),
  );

  it.effect("take a provider's group as an account, as the breakdown names it", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* filterTraffic(usage);
        const accountId = "provider:openrouter";
        const page = yield* usage.requests({ ...range, accountId, limit: 10 });
        const { groups } = yield* usage.breakdown({ ...range, accountId, groupBy: "account" });

        expect(page.requests.map((r) => r.requestId)).toEqual(["d"]);
        expect(groups.map((g) => g.group)).toEqual(["provider:openrouter"]);
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
            fellBack: 0,
            measured: 5,
            unmeasured: 0,
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
                unbilled: {
                  inputTokens: 500,
                  cachedTokens: 200,
                  cacheWriteTokens: 0,
                  outputTokens: 100,
                },
              },
            ],
          },
        ]);
      }),
    ),
  );

  it.effect("counts the answered requests that reported no usage, not the failed ones", () =>
    history((usage) =>
      Effect.gen(function* () {
        const none = {
          inputTokens: Option.none(),
          cachedTokens: Option.none(),
          outputTokens: Option.none(),
        };

        yield* usage.record(entry({ requestId: "answered", ...none }));
        yield* usage.record(entry({ requestId: "refused", status: 400, ...none }));
        yield* usage.record(entry({ requestId: "measured" }));

        const { groups } = yield* usage.breakdown({ from: 0, to: 2_000 * HOUR, groupBy: "model" });

        expect(groups[0]).toMatchObject({ requests: 3, errors: 1, measured: 1, unmeasured: 1 });
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
            unbilled: { inputTokens: 100, cachedTokens: 40, cacheWriteTokens: 0, outputTokens: 20 },
          },
        ]);
      }),
    ),
  );

  it.effect("keeps the input written to the cache, to price what wasn't billed", () =>
    history((usage) =>
      Effect.gen(function* () {
        const written = entry({ requestId: "a", cacheWriteTokens: Option.some(30) });
        yield* usage.record(written);
        yield* usage.record(
          entry({ requestId: "b", cacheWriteTokens: Option.some(50), costUsd: Option.some(1) }),
        );

        const page = yield* usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 });
        expect(page.requests).toContainEqual(written);

        const { groups } = yield* usage.breakdown({ from: 0, to: 2_000 * HOUR, groupBy: "model" });
        expect(groups[0]?.models[0]?.unbilled).toEqual({
          inputTokens: 100,
          cachedTokens: 40,
          cacheWriteTokens: 30,
          outputTokens: 20,
        });
      }),
    ),
  );

  it.effect("times the first chunk of answered requests only, not of errors", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry({ requestId: "ok", firstChunkMs: Option.some(2_000) }));

        yield* usage.record(
          entry({ requestId: "refused", status: 400, firstChunkMs: Option.some(250) }),
        );

        const result = yield* usage.breakdown({ from: 0, to: 2_000 * HOUR, groupBy: "model" });

        expect(result.firstChunkMs).toEqual({ p50: Option.some(2_000), p95: Option.some(2_000) });
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

/**
 * Ten days from 27 March 2026, across Europe's change to summer time on the 29th
 * and South Australia's change back on 5 April.
 */
const SPAN = { from: Date.parse("2026-03-27T00:00:00Z"), to: Date.parse("2026-04-06T00:00:00Z") };

/** A request, in small ranges so that property runs share hours, models and keys. */
const Spec = Schema.Struct({
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 239 })),
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
    at: SPAN.from + spec.hour * HOUR + i,
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

/** Zones whole and part hours off UTC, with and without summer time, Lord Howe's only half an hour. */
const zones = Arbitrary.schema(
  Schema.Literals([
    "UTC",
    "Europe/Amsterdam",
    "America/New_York",
    "Australia/Adelaide",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Australia/Lord_Howe",
  ]),
);

/**
 * One formatter per zone and pattern. Making an `Intl.DateTimeFormat` costs far
 * more than formatting with one, and the bucket property formats thousands of
 * times a run: building each anew took it past five seconds on CI's macOS runner.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (name: string, locale: string, options: Intl.DateTimeFormatOptions) => {
  const id = `${name} ${options.timeZone}`;
  const known = formatters.get(id);

  if (known !== undefined) return known;

  const made = new Intl.DateTimeFormat(locale, options);

  formatters.set(id, made);

  return made;
};

/** The local hour, with its offset to tell a repeated hour apart, or the local day, of `at` in `zone`. */
const localBucket = (at: number, bucket: "hour" | "day", zone: string) =>
  formatter(bucket, "en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(bucket === "hour" ? { hour: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" } : {}),
  }).format(at);

/** The local time of day of `at` in `zone`, as `HH:mm`. */
const localTime = (at: number, zone: string) =>
  formatter("time", "en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);

/** How far `zone` is off UTC at `at`, as `GMT+10:30`. */
const localOffset = (at: number, zone: string) =>
  formatter("offset", "en-GB", { timeZone: zone, timeZoneName: "longOffset" }).format(at);

const sum = (values: ReadonlyArray<number>) => values.reduce((a, b) => a + b, 0);

/**
 * The history the shared layer holds, emptied first. A property runs a hundred
 * times, and opening and migrating a database for each run took over five
 * seconds on CI's slowest runner; clearing one costs next to nothing.
 */
const emptied = <A, E>(body: (history: UsageHistory["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(UsageHistory, (usage) => Effect.andThen(usage.clear, body(usage)));

layer(UsageHistory.layerMemory)("UsageHistory properties", (shared) => {
  shared.effect.prop(
    "the series and the breakdown both add up to every request's tokens, however they group",
    { specs, groupBy: groupings, bucket: buckets, zone: zones },
    ({ specs: values, groupBy, bucket, zone }) =>
      emptied((usage) =>
        Effect.gen(function* () {
          const entries = values.map(toEntry);
          yield* Effect.forEach(entries, usage.record, { discard: true });
          const range = SPAN;
          const timeZone = DateTime.zoneMakeNamedUnsafe(zone);
          const points = yield* usage.series({ ...range, bucket, timeZone, groupBy });
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

  shared.effect.prop(
    "a bucket holds the requests of one local hour or day, and starts when it does",
    { specs, bucket: buckets, zone: zones },
    ({ specs: values, bucket, zone }) =>
      emptied((usage) =>
        Effect.gen(function* () {
          const entries = values.map(toEntry);
          yield* Effect.forEach(entries, usage.record, { discard: true });

          const points = yield* usage.series({
            ...SPAN,
            bucket,
            timeZone: DateTime.zoneMakeNamedUnsafe(zone),
            groupBy: "model",
          });

          for (const point of points) {
            const local = localBucket(point.bucket, bucket, zone);

            const inside = entries.filter(
              (e) => e.model === point.group && localBucket(e.at, bucket, zone) === local,
            );

            expect(inside.length).toBe(point.requests);
            expect(localBucket(point.bucket - 1, bucket, zone)).not.toBe(local);

            // An hour starts on the hour, or where the clocks change by half an hour.
            const changed = localOffset(point.bucket - 1, zone) !== localOffset(point.bucket, zone);

            if (bucket === "day") expect(localTime(point.bucket, zone)).toBe("00:00");
            else if (!changed) expect(localTime(point.bucket, zone)).toMatch(/:00$/);
          }
        }),
      ),
  );

  shared.effect.prop(
    "pruning never forgets a request from the last 90 days",
    {
      ages: Arbitrary.array(
        Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
        { maxLength: 20 },
      ),
    },
    ({ ages }) => {
      const now = 400 * DAY;

      return Effect.andThen(
        TestClock.setTime(now),
        emptied((usage) =>
          Effect.gen(function* () {
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
    },
  );
});

const DAY = 24 * HOUR;

/** A turn of conversation `id`, under `parent` for a sub-agent's. */
const turn = (
  requestId: string,
  at: number,
  id: string,
  parent?: string,
  overrides: Partial<UsageEntry> = {},
) =>
  entry({
    requestId,
    at,
    conversationId: Option.some(id),
    parentConversationId: Option.fromUndefinedOr(parent),
    sessionSource: Option.some("x-session-id"),
    client: Option.some("opencode/1.19.3"),
    ...overrides,
  });

/** One conversation with a sub-agent and its own sub-agent, another, and a request without one. */
const conversations = [
  turn("r1", 1 * HOUR, "root"),
  turn("r2", 2 * HOUR, "child", "root", { model: "gpt-6-sol", agentType: Option.some("review") }),
  turn("r3", 3 * HOUR, "grandchild", "child", {
    status: 500,
    error: Option.some("server_error"),
    inputTokens: Option.none(),
    cachedTokens: Option.none(),
    outputTokens: Option.none(),
  }),
  turn("r4", 4 * HOUR, "root", undefined, {
    requestedModel: Option.some("gpt-6-sol"),
    fallbackReason: Option.some("rate_limit_exceeded"),
  }),
  turn("r5", 5 * HOUR, "other", undefined, {
    sessionSource: Option.some("hash"),
    client: Option.none(),
    keyName: Option.some("ci"),
  }),
  entry({ requestId: "r6", at: 6 * HOUR }),
];

describe("UsageHistory.conversations", () => {
  const all = { from: 0, to: 2_000 * HOUR, limit: 10 };

  it.effect("lists the conversations that no other started, the latest active first", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* Effect.forEach(conversations, usage.record, { discard: true });
        const page = yield* usage.conversations(all);

        expect(page.conversations.map((c) => c.id)).toEqual(["other", "root"]);
        expect(page.next).toEqual(Option.none());

        expect(page.conversations[1]).toMatchObject({
          id: "root",
          source: "x-session-id",
          client: Option.some("opencode/1.19.3"),
          keyName: Option.some("laptop"),
          firstAt: 1 * HOUR,
          lastAt: 4 * HOUR,
          // Its sub-agents' turns count as its own.
          turns: 4,
          subagents: 2,
          failed: 1,
          fellBack: 1,
          inputTokens: 300,
          cachedTokens: 120,
          outputTokens: 60,
          reasoningTokens: 0,
        });

        expect(page.conversations[1]?.models.map((m) => m.model).toSorted()).toEqual([
          "gpt-6-astra",
          "gpt-6-sol",
        ]);

        expect(page.conversations[0]).toMatchObject({
          source: "hash",
          client: Option.none(),
          keyName: Option.some("ci"),
          turns: 1,
          subagents: 0,
        });
      }),
    ),
  );

  it.effect("pages on the latest activity, without skipping conversations that share it", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          [turn("a1", HOUR, "a"), turn("b1", HOUR, "b"), turn("c1", 2 * HOUR, "c")],
          usage.record,
          { discard: true },
        );

        const first = yield* usage.conversations({ ...all, limit: 2 });
        expect(first.conversations.map((c) => c.id)).toEqual(["c", "b"]);
        expect(first.next).toEqual(Option.some({ at: HOUR, id: "b" }));

        const second = yield* usage.conversations({
          ...all,
          limit: 2,
          cursor: Option.getOrUndefined(first.next),
        });

        expect(second.conversations.map((c) => c.id)).toEqual(["a"]);
        expect(second.next).toEqual(Option.none());
      }),
    ),
  );

  it.effect("counts only the turns in the range that the filters keep", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* Effect.forEach(conversations, usage.record, { discard: true });

        const recent = yield* usage.conversations({ ...all, from: 2 * HOUR, to: 4 * HOUR });
        expect(recent.conversations).toMatchObject([{ id: "root", turns: 2, subagents: 2 }]);

        const sol = yield* usage.conversations({ ...all, model: "gpt-6-sol" });
        expect(sol.conversations).toMatchObject([{ id: "root", turns: 1, subagents: 1 }]);
      }),
    ),
  );
});

describe("UsageHistory.conversation", () => {
  it.effect("gives a conversation's turns and its sub-agents', in order, and its totals", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* Effect.forEach(conversations.toReversed(), usage.record, { discard: true });
        const found = yield* usage.conversation("root");

        expect(Option.map(found, (c) => c.turns.map((t) => t.requestId))).toEqual(
          Option.some(["r1", "r2", "r3", "r4"]),
        );

        expect(Option.map(found, (c) => c.summary)).toMatchObject(
          Option.some({ id: "root", turns: 4, subagents: 2, lastAt: 4 * HOUR }),
        );
      }),
    ),
  );

  it.effect("finds no conversation it has no request of", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* Effect.forEach(conversations, usage.record, { discard: true });
        expect(yield* usage.conversation("nope")).toEqual(Option.none());
      }),
    ),
  );
});

describe("UsageHistory.changes", () => {
  it.effect("signals at once, then after each request kept and each clear", () =>
    history((usage) =>
      Effect.gen(function* () {
        const seen = yield* usage.changes.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* usage.record(entry());
        yield* usage.clear;

        expect(yield* Fiber.join(seen)).toHaveLength(3);
      }),
    ),
  );
});

describe("UsageHistory.clear", () => {
  it.effect("forgets every request, and says how many", () =>
    history((usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry({ requestId: "a" }));
        yield* usage.record(entry({ requestId: "b" }));

        expect(yield* usage.clear).toBe(2);
        expect((yield* usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 })).requests).toEqual(
          [],
        );
      }),
    ),
  );
});

describe("UsageHistory retention", () => {
  it.effect("forgets requests older than 90 days, and only those", () => {
    const now = 200 * DAY;

    return historyAt(now, (usage) =>
      Effect.gen(function* () {
        yield* usage.record(entry({ requestId: "old", at: now - 90 * DAY - 1 }));
        yield* usage.record(entry({ requestId: "edge", at: now - 90 * DAY }));
        yield* usage.record(entry({ requestId: "new", at: now - DAY }));

        yield* usage.prune;

        const page = yield* usage.requests({ from: 0, to: now, limit: 10 });
        expect(page.requests.map((r) => r.requestId)).toEqual(["new", "edge"]);
      }),
    );
  });

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
  withFs.effect("forgets the upstream's words an older via kept of why a request failed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = `${yield* fs.makeTempDirectoryScoped()}/usage.db`;
      const open = UsageHistory.layer(path);
      const prompt = "REVIEW_PRIVATE_PROMPT_7a19";

      const kept = [
        entry({
          requestId: "r1",
          status: 400,
          error: Option.some("invalid_input"),
          // Long enough to spill into overflow pages, which clearing it frees.
          errorMessage: Option.some(`Can't read ${`${prompt} `.repeat(1_000)}`),
        }),
        entry({
          requestId: "r2",
          status: 400,
          error: Option.some(`bad input: ${prompt}`),
          requestedModel: Option.some("gpt-6-sol"),
          fallbackReason: Option.some(`bad input: ${prompt}`),
        }),
        entry({
          requestId: "r3",
          status: 429,
          error: Option.some("rate_limit_exceeded"),
          errorMessage: Option.some("Every account is cooling down"),
          requestedModel: Option.some("gpt-6-sol"),
          fallbackReason: Option.some("rate_limit_exceeded"),
        }),
      ];

      yield* Effect.flatMap(UsageHistory, (usage) =>
        Effect.forEach(kept, usage.record, { discard: true }),
      ).pipe(Effect.provide(open));

      // The database as an older via left it: one that never ran the migration that forgets
      // them, nor any after it.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Dropping a column copies the table; this leaves no copy of the words behind.
        yield* sql`PRAGMA secure_delete = ON`;
        yield* sql`DROP INDEX requests_conversation`;
        yield* sql`DROP INDEX requests_parent`;

        for (const column of [
          "conversation_id",
          "parent_conversation_id",
          "session_source",
          "agent_type",
          "client",
        ]) {
          yield* sql`ALTER TABLE requests DROP COLUMN ${sql(column)}`;
        }

        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 5`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: path })));

      const page = yield* Effect.flatMap(UsageHistory, (usage) =>
        usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 }),
      ).pipe(Effect.provide(open));

      const byId = new Map(page.requests.map((request) => [request.requestId, request]));

      expect(byId.get("r1")).toMatchObject({
        error: Option.some("invalid_input"),
        errorMessage: Option.none(),
      });

      expect(byId.get("r2")).toMatchObject({
        error: Option.none(),
        requestedModel: Option.some("gpt-6-sol"),
        fallbackReason: Option.none(),
      });

      // via's own words can't be told from an upstream's, so they go too; its codes stay.
      expect(byId.get("r3")).toMatchObject({
        error: Option.some("rate_limit_exceeded"),
        errorMessage: Option.none(),
        fallbackReason: Option.some("rate_limit_exceeded"),
      });

      expect(JSON.stringify(page.requests)).not.toContain(prompt);

      // Nor are its bytes left in the file, in a page's free space, once the WAL is moved in.
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`PRAGMA wal_checkpoint(TRUNCATE)`,
      ).pipe(Effect.provide(SqliteClient.layer({ filename: path })));

      for (const file of [path, `${path}-wal`]) {
        if (!(yield* fs.exists(file))) continue;
        const bytes = new TextDecoder("latin1").decode(yield* fs.readFile(file));

        expect(bytes).not.toContain(prompt);
      }
    }),
  );

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
  withFs.effect("preserves a database created after an existence check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = `${yield* fs.makeTempDirectoryScoped()}/usage.db`;
      const checked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const delayed = FileSystem.FileSystem.of({
        ...fs,
        exists: (filename) =>
          fs
            .exists(filename)
            .pipe(
              Effect.tap((exists) =>
                filename === path && !exists
                  ? Effect.andThen(Deferred.succeed(checked, undefined), Deferred.await(release))
                  : Effect.void,
              ),
            ),
      });

      const opening = yield* Effect.flatMap(UsageHistory, (usage) =>
        usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 }),
      ).pipe(
        Effect.provide(UsageHistory.layer(path)),
        Effect.provideService(FileSystem.FileSystem, delayed),
        Effect.forkChild,
      );

      yield* Deferred.await(checked);

      const saved = yield* Effect.flatMap(UsageHistory, (usage) =>
        Effect.andThen(
          usage.record(entry()),
          usage.requests({ from: 0, to: 2_000 * HOUR, limit: 10 }),
        ),
      ).pipe(Effect.provide(UsageHistory.layer(path)));

      expect(saved.requests).toEqual([entry()]);
      yield* Deferred.succeed(release, undefined);
      const page = yield* Fiber.join(opening);
      expect(page.requests).toEqual([entry()]);
    }),
  );
});
