// Deliberately not `withVia` (harness.ts): this poller has nothing to do with the
// HTTP API surface `withVia` sets up, and a smaller, local setup keeps this test
// isolated from changes other features make to that shared harness.
import { BunFileSystem } from "@effect/platform-bun";
import { type Account, AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { fakeIssuer, jwt } from "@via/codex-auth/testing";
import { CodexUpstream } from "@via/codex-upstream";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { PoolStates, type PoolStatesShape } from "@via/pool";
import { expect, layer } from "@effect/vitest";
import { Clock, Deferred, Effect, FileSystem, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpClient, HttpServer } from "effect/unstable/http";
import { UsagePoll } from "./usage-poll.ts";

/** Mirrors the poll's own interval: this suite shares one `TestClock` across its
 * tests (via `@effect/vitest`'s `layer`), so times are computed relative to
 * `start`, never assumed to start at 0. */
const POLL_MS = 15 * 60 * 1000;

/** Tokens for a ChatGPT account named `name`, valid far into the future unless
 * `overrides` (computed from the poll's own `start`) says otherwise. */
const accountTokens = (
  name: string,
  overrides: Partial<{ refreshToken: string; expiresAt: number }>,
) => ({
  idToken: jwt({
    email: `${name}@example.com`,
    "https://api.openai.com/auth": { chatgpt_account_id: `acc-${name}`, chatgpt_plan_type: "pro" },
  }),
  accessToken: `at-${name}`,
  refreshToken: `rt-${name}`,
  expiresAt: 1e15,
  ...overrides,
});

/** A window's usage, in the shape `/wham/usage` answers with; `resetAtMs` is epoch millis. */
const window = (usedPercent: number, resetAtMs: number) => ({
  used_percent: usedPercent,
  limit_window_seconds: 18_000,
  reset_at: resetAtMs / 1000,
});

/** A logger that keeps every line, and `logged(text)`, which waits for one containing `text`. */
const collectLogs = () => {
  const lines: Array<string> = [];
  const waiters: Array<{ text: string; done: Deferred.Deferred<void> }> = [];
  const logger = Logger.make(({ message }) => {
    const line = `${(Array.isArray(message) ? message : [message]).join(" ")}`;
    lines.push(line);
    for (const waiter of waiters.filter(({ text }) => line.includes(text))) {
      Deferred.doneUnsafe(waiter.done, Effect.void);
    }
  });
  const logged = (text: string) =>
    Effect.suspend(() => {
      if (lines.some((line) => line.includes(text))) return Effect.void;
      const waiter = { text, done: Deferred.makeUnsafe<void>() };
      waiters.push(waiter);
      return Deferred.await(waiter.done);
    });
  return { logger, logged };
};

/**
 * Starts `UsagePoll` against a fake Codex, with one account named `name`, far
 * from token expiry unless `tokens` says otherwise. `body` gets the saved
 * `account` (its `id` is random, so tests read it from here rather than
 * assuming one), the fake Codex (to script `/wham/usage`), the pool's
 * `PoolStates`, and `start`, the clock time (this suite's `TestClock` is
 * shared and cumulative across tests, so `start` is how a test finds where
 * its own poll's first interval will land, and how `tokens` computes an
 * `expiresAt`/`refreshToken` relative to it rather than as a bare literal).
 */
const withPoll = <A, E>(
  name: string,
  body: (args: {
    account: Account;
    codex: Effect.Success<typeof startFakeCodex>;
    states: PoolStatesShape;
    logged: (text: string) => Effect.Effect<void>;
    start: number;
  }) => Effect.Effect<A, E>,
  options: {
    authLayer?: Layer.Layer<CodexAuth, never, HttpClient.HttpClient>;
    tokens?: (start: number) => Partial<{ refreshToken: string; expiresAt: number }>;
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
      CodexUpstream.layer({ baseUrl: codex.url, cloak: true }),
    ).pipe(Layer.provide(FetchHttpClient.layer));
    const built = yield* Layer.build(services);

    const account = yield* Effect.gen(function* () {
      return yield* (yield* AccountStore).save(accountTokens(name, options.tokens?.(start) ?? {}));
    }).pipe(Effect.provide(built));

    const logs = collectLogs();
    const runtime = yield* Layer.build(
      UsagePoll.layer.pipe(
        Layer.provide(Logger.layer([logs.logger])),
        Layer.provideMerge(PoolStates.layer),
        Layer.provideMerge(Layer.succeedContext(built)),
      ),
    );

    return yield* Effect.gen(function* () {
      const states = yield* PoolStates;
      return yield* body({ account, codex, states, logged: logs.logged, start });
    }).pipe(Effect.provide(runtime));
    // Debug-level lines are filtered out by default; the poll's "nothing changed"
    // and "could not poll" lines are the deterministic sync point tests wait on.
  }).pipe(Effect.provideService(References.MinimumLogLevel, "Debug"));

layer(BunFileSystem.layer)("UsagePoll", (it) => {
  it.effect("does not poll before the first interval has passed", () =>
    withPoll("a", ({ codex }) => Effect.sync(() => expect(codex.requests).toHaveLength(0))),
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
          [account.id]: { status: "cooling", until: resetsAt, reason: "usage_limit_reached" },
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
        expect(codex.requests).toHaveLength(1);

        // The scripted window's reset has now passed, so the second pass finds
        // nothing exhausted -- but it must still run, on its own 15-minute beat.
        yield* TestClock.adjust("15 minutes");
        yield* logged(`${account.label}'s usage is unchanged`);
        expect(codex.requests).toHaveLength(2);
        expect(yield* states.get).toEqual({
          [account.id]: { status: "cooling", until: resetsAt, reason: "usage_limit_reached" },
        });
      }),
    ),
  );

  it.effect("extends a running cooldown to a later verified reset", () =>
    withPoll("a", ({ account, codex, states, logged, start }) =>
      Effect.gen(function* () {
        const currentUntil = start + POLL_MS + 100_000;
        const resetsAt = start + POLL_MS + 300_000;
        yield* states.mark(account.id, {
          status: "cooling",
          until: currentUntil,
          reason: "usage_limit_reached",
        });
        codex.usage("acc-a", {
          rate_limit: { primary_window: window(100, resetsAt), secondary_window: null },
        });
        yield* TestClock.adjust("15 minutes");
        yield* logged(`${account.label} is cooling down until`);
        expect(yield* states.get).toEqual({
          [account.id]: { status: "cooling", until: resetsAt, reason: "usage_limit_reached" },
        });
      }),
    ),
  );

  it.effect("never shortens a running cooldown", () =>
    withPoll("a", ({ account, codex, states, logged, start }) =>
      Effect.gen(function* () {
        const currentUntil = start + POLL_MS + 500_000;
        const resetsAt = start + POLL_MS + 100_000;
        yield* states.mark(account.id, {
          status: "cooling",
          until: currentUntil,
          reason: "usage_limit_reached",
        });
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
        const issuer = yield* HttpServer.addressFormattedWith(Effect.succeed);
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
            // Due to expire at the poll's own first interval, so `AccountTokens.fresh`
            // refreshes it -- and "rt-1" is the one refresh token this fake issuer accepts.
            tokens: (start) => ({ refreshToken: "rt-1", expiresAt: start + POLL_MS + 60_000 }),
          },
        );
      }).pipe(
        Effect.provide(
          fakeIssuer({ refreshResponse: { status: 400, body: { error: "invalid_grant" } } }),
        ),
      ),
  );
});
