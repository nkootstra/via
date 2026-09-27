import { BunFileSystem } from "@effect/platform-bun";
import { type Account, AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { startFakeIssuer, tokensFor } from "@via/codex-auth/testing";
import { CodexUpstream } from "@via/codex-upstream";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { PoolStates } from "@via/pool";
import { OpencodeGoAccounts, OpencodeGoPool, Providers } from "@via/providers";
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, FileSystem, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { AccountPool } from "./account-pool.ts";
import { collectLogs } from "./testing/logs.ts";
import { UsagePoll } from "./usage-poll.ts";
import { UsageSnapshots } from "./usage-snapshots.ts";

/** Mirrors the poll's own interval: this suite shares one `TestClock` across its
 * tests (via `@effect/vitest`'s `layer`), so times are computed relative to
 * `start`, never assumed to start at 0. */
const POLL_MS = 15 * 60 * 1000;

/** A window's usage, in the shape `/wham/usage` answers with; `resetAtMs` is epoch millis. */
const window = (usedPercent: number, resetAtMs: number) => ({
  used_percent: usedPercent,
  limit_window_seconds: 18_000,
  reset_at: resetAtMs / 1000,
});

/**
 * Starts `UsagePoll` against a fake Codex, with one account named `name`, far
 * from token expiry unless `tokens` says otherwise, and waits for the pass it
 * runs at startup, against the usage `startup` scripts (by default,
 * `usagePayload`'s), before running `body`. `body` gets the saved
 * `account` (its `id` is random, so tests read it from here rather than
 * assuming one), the fake Codex (to script `/wham/usage`), the pool's
 * `PoolStates`, the account files' `authDir`, and `start`, the clock time (this suite's `TestClock` is
 * shared and cumulative across tests, so `start` is how a test finds where
 * its own poll's first interval will land, and how `tokens` computes an
 * `expiresAt` relative to it rather than as a bare literal).
 */
const withPoll = <A, E>(
  name: string,
  body: (args: {
    account: Account;
    codex: Effect.Success<typeof startFakeCodex>;
    states: PoolStates["Service"];
    logged: (text: string) => Effect.Effect<void>;
    start: number;
    authDir: string;
  }) => Effect.Effect<A, E>,
  options: {
    authLayer?: Layer.Layer<CodexAuth, never, HttpClient.HttpClient>;
    tokens?: (start: number) => { expiresAt: number };
    startup?: (codex: Effect.Success<typeof startFakeCodex>, start: number) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const codex = yield* startFakeCodex;
    const start = yield* Clock.currentTimeMillis;

    const services = Layer.mergeAll(
      AccountTokens.layer.pipe(
        Layer.provide(options.authLayer ?? CodexAuth.layer("http://127.0.0.1:1")),
        Layer.provideMerge(AccountStore.layer(`${dir}/auth`)),
      ),
      CodexUpstream.layer({ baseUrl: codex.url, cloak: true, version: "0.0.0" }),
      Providers.layer({ providers: {}, apiKeys: {}, version: "0.0.0" }).pipe(
        Layer.provideMerge(OpencodeGoAccounts.layer(`${dir}/opencode-go.json`)),
      ),
    ).pipe(Layer.provide(FetchHttpClient.layer));

    const built = yield* Layer.build(services);

    const account = yield* Effect.gen(function* () {
      return yield* (yield* AccountStore).save(tokensFor(name, options.tokens?.(start)));
    }).pipe(Effect.provide(built));

    const logs = collectLogs();
    options.startup?.(codex, start);

    const runtime = yield* Layer.build(
      UsagePoll.layer.pipe(
        Layer.provide(Layer.mergeAll(AccountPool.layer, OpencodeGoPool.layer)),
        Layer.provide(UsageSnapshots.layer),
        Layer.provide(Logger.layer([logs.logger])),
        Layer.provideMerge(PoolStates.layer),
        Layer.provideMerge(Layer.succeedContext(built)),
      ),
    );

    // Every outcome of the startup pass logs a line naming the account.
    yield* logs.logged(account.label);
    yield* logs.forget;

    return yield* Effect.gen(function* () {
      const states = yield* PoolStates;

      return yield* body({
        account,
        codex,
        states,
        logged: logs.logged,
        start,
        authDir: `${dir}/auth`,
      });
    }).pipe(Effect.provide(runtime));
    // Debug-level lines are filtered out by default; the poll's "nothing changed"
    // and "could not poll" lines are the deterministic sync point tests wait on.
  }).pipe(Effect.provideService(References.MinimumLogLevel, "Debug"));

layer(BunFileSystem.layer)("UsagePoll", (it) => {
  it.effect("polls once at startup, before the first interval has passed", () =>
    withPoll("a", ({ codex }) => Effect.sync(() => expect(codex.requests).toHaveLength(1))),
  );

  it.effect("cools an exhausted account down at startup", () =>
    withPoll(
      "a",
      ({ account, states, start }) =>
        Effect.gen(function* () {
          expect(yield* states.get).toEqual({
            [account.id]: {
              status: "cooling",
              until: start + 100_000,
              reason: "usage_exhausted",
            },
          });
        }),
      {
        startup: (codex, start) =>
          codex.usage("acc-a", {
            rate_limit: { primary_window: window(100, start + 100_000), secondary_window: null },
          }),
      },
    ),
  );

  it.effect("cools an exhausted account down after the first interval", () =>
    withPoll("a", ({ account, codex, states, logged, start }) =>
      Effect.gen(function* () {
        const resetsAt = start + POLL_MS + 100_000;
        codex.usage("acc-a", {
          rate_limit: { primary_window: window(100, resetsAt), secondary_window: null },
        });
        yield* TestClock.adjust("15 minutes");
        yield* logged(`${account.label} is cooling down`);
        expect(yield* states.get).toEqual({
          [account.id]: { status: "cooling", until: resetsAt, reason: "usage_exhausted" },
        });
      }),
    ),
  );

  it.effect("keeps polling every interval, not just once", () =>
    withPoll("a", ({ account, codex, states, logged, start }) =>
      Effect.gen(function* () {
        const resetsAt = start + POLL_MS + 100_000;
        codex.usage("acc-a", {
          rate_limit: { primary_window: window(100, resetsAt), secondary_window: null },
        });
        yield* TestClock.adjust("15 minutes");
        yield* logged(`${account.label} is cooling down`);
        expect(codex.requests).toHaveLength(2);

        // The scripted window's reset has now passed, so the second pass finds
        // nothing exhausted -- but it must still run, on its own 15-minute beat.
        yield* TestClock.adjust("15 minutes");
        yield* logged(`${account.label}'s usage is unchanged`);
        expect(codex.requests).toHaveLength(3);
        expect(yield* states.get).toEqual({
          [account.id]: { status: "cooling", until: resetsAt, reason: "usage_exhausted" },
        });
      }),
    ),
  );

  it.effect("extends a running cooldown to a later verified reset", () =>
    withPoll("a", ({ account, codex, states, logged, start }) =>
      Effect.gen(function* () {
        const currentUntil = start + POLL_MS + 100_000;
        const resetsAt = start + POLL_MS + 300_000;
        yield* states.coolDown(account.id, currentUntil, "usage_limit_reached");
        codex.usage("acc-a", {
          rate_limit: { primary_window: window(100, resetsAt), secondary_window: null },
        });
        yield* TestClock.adjust("15 minutes");
        yield* logged(`${account.label} is cooling down until`);
        expect(yield* states.get).toEqual({
          [account.id]: { status: "cooling", until: resetsAt, reason: "usage_exhausted" },
        });
      }),
    ),
  );

  it.effect("never shortens a running cooldown", () =>
    withPoll("a", ({ account, codex, states, logged, start }) =>
      Effect.gen(function* () {
        const currentUntil = start + POLL_MS + 500_000;
        const resetsAt = start + POLL_MS + 100_000;
        yield* states.coolDown(account.id, currentUntil, "usage_limit_reached");
        codex.usage("acc-a", {
          rate_limit: { primary_window: window(100, resetsAt), secondary_window: null },
        });
        yield* TestClock.adjust("15 minutes");
        yield* logged(`${account.label}'s usage is unchanged`);
        expect(yield* states.get).toEqual({
          [account.id]: { status: "cooling", until: currentUntil, reason: "usage_limit_reached" },
        });
      }),
    ),
  );

  it.effect("leaves the account's state untouched when usage is unavailable", () =>
    withPoll("a", ({ account, codex, states, logged }) =>
      Effect.gen(function* () {
        codex.usage("acc-a", {}, 401);
        yield* TestClock.adjust("15 minutes");
        yield* logged(`Could not poll ${account.label}'s usage`);
        expect(yield* states.get).toEqual({});
      }),
    ),
  );

  it.effect(
    "leaves the account's state untouched, and does not lock it out, when Codex rejects its refreshed token",
    () =>
      Effect.gen(function* () {
        const issuer = yield* startFakeIssuer({
          refreshResponse: { status: 400, body: { error: "invalid_grant" } },
        });

        yield* withPoll(
          "a",
          ({ account, states, logged }) =>
            Effect.gen(function* () {
              yield* TestClock.adjust("15 minutes");
              yield* logged(`Could not poll ${account.label}'s usage`);
              expect(yield* states.get).toEqual({});
            }),
          {
            authLayer: CodexAuth.layer(issuer),
            // Due to expire at the poll's own first interval, so `AccountTokens.fresh` refreshes it.
            tokens: (start) => ({ expiresAt: start + POLL_MS + 60_000 }),
          },
        );
      }),
  );

  it.effect("warns when a pass cannot read the accounts, and still runs the next pass", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* withPoll("a", ({ account, codex, logged, authDir }) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${authDir}/broken.json`, "not json");
          yield* TestClock.adjust("15 minutes");
          yield* logged("usage poll pass failed");
          expect(codex.requests).toHaveLength(1);

          yield* fs.remove(`${authDir}/broken.json`);
          codex.usage("acc-a", {}, 401);
          yield* TestClock.adjust("15 minutes");
          yield* logged(`Could not poll ${account.label}'s usage`);
          expect(codex.requests).toHaveLength(2);
        }),
      );
    }),
  );
});
