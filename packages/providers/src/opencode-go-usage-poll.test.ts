import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { PoolStates } from "@via/pool";
import { Clock, Deferred, Effect, FileSystem, Layer, Logger, Redacted, References } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import {
  type OpencodeGoAccount,
  OpencodeGoAccounts,
  OpencodeGoPool,
  OpencodeGoUsagePoll,
  Providers,
} from "./index.ts";
import { type FakeProvider, startFakeProvider } from "./testing/index.ts";

/** The poll's own interval. This suite's TestClock is shared, so times are relative to `start`. */
const POLL_MS = 15 * 60 * 1000;

/** opencode Go's usage with one window, `weekly`, `percent` used until `resetsAt` (epoch ms). */
const weekly = (percent: number, resetsAt: number) => ({
  usage: {
    weekly: { status: "ok", percent, resetsAt: new Date(resetsAt).toISOString() },
  },
});

/** A logger, and `logged(text)`, which waits until it has logged a line containing `text`. */
const collectLogs = () => {
  const lines: Array<string> = [];
  const waiters: Array<{ text: string; seen: Deferred.Deferred<void> }> = [];

  const logger = Logger.make(({ message }) => {
    const line = (Array.isArray(message) ? message : [message]).join(" ");
    lines.push(line);

    for (const waiter of waiters.filter(({ text }) => line.includes(text))) {
      Deferred.doneUnsafe(waiter.seen, Effect.void);
    }
  });

  const logged = (text: string) =>
    Effect.suspend(() => {
      if (lines.some((line) => line.includes(text))) return Effect.void;
      const waiter = { text, seen: Deferred.makeUnsafe<void>() };
      waiters.push(waiter);

      return Deferred.await(waiter.seen);
    });

  return { logger, logged };
};

/**
 * Starts the poll with an opencode Go account for each of `keys`, served by a
 * fake provider; `body` gets the accounts, the fake, the pool's states, `start`
 * and `logged`, which waits for a line the poll logs.
 */
const withPoll = <A, E>(
  keys: ReadonlyArray<{ key: string; enabled?: boolean }>,
  body: (args: {
    accounts: ReadonlyArray<OpencodeGoAccount>;
    provider: FakeProvider;
    states: PoolStates["Service"];
    start: number;
    logged: (text: string) => Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${yield* fs.makeTempDirectoryScoped()}/opencode-go.json`;
    const provider = yield* startFakeProvider;
    const start = yield* Clock.currentTimeMillis;

    const services = Providers.layer({
      providers: { "opencode-go": { baseUrl: provider.url, apiKeyEnv: "KEY" } },
      apiKeys: {},
      version: "0.0.0",
    }).pipe(
      Layer.provideMerge(OpencodeGoAccounts.layer(file)),
      Layer.provideMerge(PoolStates.layer),
      Layer.provide(FetchHttpClient.layer),
    );

    const built = yield* Layer.build(services);

    const accounts = yield* Effect.gen(function* () {
      const store = yield* OpencodeGoAccounts;

      for (const { key, enabled = true } of keys) {
        const { id } = yield* store.add(Redacted.make(key));

        if (!enabled) yield* store.setEnabled(id, false);
        yield* TestClock.adjust("1 millis");
      }

      return yield* store.list;
    }).pipe(Effect.provide(built));

    const logs = collectLogs();

    yield* Layer.build(
      OpencodeGoUsagePoll.layer.pipe(
        Layer.provide(OpencodeGoPool.layer),
        Layer.provide(Logger.layer([logs.logger])),
        Layer.provide(Layer.succeedContext(built)),
      ),
    );

    return yield* Effect.gen(function* () {
      const states = yield* PoolStates;

      return yield* body({ accounts, provider, states, start, logged: logs.logged });
    }).pipe(Effect.provide(built));
    // Debug lines, filtered out by default, are what tests wait on.
  }).pipe(Effect.provideService(References.MinimumLogLevel, "Debug"));

layer(BunFileSystem.layer)("OpencodeGoUsagePoll", (it) => {
  it.effect("cools an account down until its used-up window resets, at the next poll", () =>
    withPoll([{ key: "sk-1" }, { key: "sk-2" }], ({ accounts, provider, states, start, logged }) =>
      Effect.gen(function* () {
        const reset = start + POLL_MS * 10;
        provider.usageFor("sk-1", weekly(100, reset));
        provider.usageFor("sk-2", weekly(40, reset));
        expect(yield* states.get).toEqual({});
        yield* TestClock.adjust(POLL_MS);
        yield* logged(`${accounts[1]?.label}'s usage is unchanged`);

        expect(yield* states.get).toEqual({
          [accounts[0]?.id ?? ""]: { status: "cooling", until: reset, reason: "usage_exhausted" },
        });
      }),
    ),
  );

  it.effect("leaves an account alone when its usage can't be read", () =>
    withPoll([{ key: "sk-1" }], ({ provider, states, logged }) =>
      Effect.gen(function* () {
        provider.usageFor("sk-1", { error: "unauthorized" }, 401);
        yield* TestClock.adjust(POLL_MS);
        yield* logged("Could not poll");
        expect(provider.usageRequests).toHaveLength(1);
        expect(yield* states.get).toEqual({});
      }),
    ),
  );

  it.effect("does not ask about a disabled account", () =>
    withPoll([{ key: "sk-1", enabled: false }, { key: "sk-2" }], ({ provider, logged }) =>
      Effect.gen(function* () {
        provider.usage(weekly(0, 0));
        yield* TestClock.adjust(POLL_MS);
        yield* logged("usage is unchanged");
        expect(provider.usageRequests.map(({ headers }) => headers["authorization"])).toEqual([
          "Bearer sk-2",
        ]);
      }),
    ),
  );
});
