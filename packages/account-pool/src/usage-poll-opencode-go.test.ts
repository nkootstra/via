import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { PoolStates } from "@via/pool";
import {
  type OpencodeGoAccount,
  OpencodeGoAccounts,
  OpencodeGoPool,
  Providers,
} from "@via/providers";
import { type FakeProvider, startFakeProvider } from "@via/providers/testing";
import { Clock, Effect, FileSystem, Layer, Logger, Redacted, References } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { AccountPool } from "./account-pool.ts";
import { collectLogs } from "./testing/logs.ts";
import { UsagePoll } from "./usage-poll.ts";
import { UsageSnapshots } from "./usage-snapshots.ts";

/** The poll's own interval. This suite's TestClock is shared, so times are relative to `start`. */
const POLL_MS = 15 * 60 * 1000;

/** opencode Go's usage with one window, `weekly`, `percent` used until `resetsAt` (epoch ms). */
const weekly = (percent: number, resetsAt: number) => ({
  usage: { weekly: { status: "ok", percent, resetsAt: new Date(resetsAt).toISOString() } },
});

/**
 * Starts `UsagePoll` with an opencode Go account for each of `keys` and no
 * ChatGPT account, and waits for the pass it runs at startup, against the usage
 * `startup` scripts. `body` gets the accounts, the fake opencode Go, the pool's
 * states, `start` and `logged`, which waits for a line the poll logs.
 */
const withPoll = <A, E>(
  keys: ReadonlyArray<string>,
  startup: (provider: FakeProvider, start: number) => void,
  body: (args: {
    accounts: ReadonlyArray<OpencodeGoAccount>;
    provider: FakeProvider;
    states: PoolStates["Service"];
    start: number;
    logged: (text: string) => Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const provider = yield* startFakeProvider;
    const start = yield* Clock.currentTimeMillis;

    const services = Layer.mergeAll(
      AccountTokens.layer.pipe(
        Layer.provide(CodexAuth.layer("http://127.0.0.1:1")),
        Layer.provideMerge(AccountStore.layer(`${dir}/auth`)),
      ),
      CodexUpstream.layer({ baseUrl: "http://127.0.0.1:1", cloak: true, version: "0.0.0" }),
      Providers.layer({
        providers: { "opencode-go": { baseUrl: provider.url, apiKeyEnv: "KEY" } },
        apiKeys: {},
        version: "0.0.0",
      }).pipe(Layer.provideMerge(OpencodeGoAccounts.layer(`${dir}/opencode-go.json`))),
    ).pipe(Layer.provide(FetchHttpClient.layer));

    const built = yield* Layer.build(services);

    const accounts = yield* Effect.gen(function* () {
      const store = yield* OpencodeGoAccounts;

      for (const key of keys) {
        yield* store.add(Redacted.make(key), `go-${key}`);
        yield* TestClock.adjust("1 millis");
      }

      return yield* store.list;
    }).pipe(Effect.provide(built));

    const logs = collectLogs();
    startup(provider, start);

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
    for (const { label } of accounts) yield* logs.logged(label);
    yield* logs.forget;

    return yield* Effect.gen(function* () {
      const states = yield* PoolStates;

      return yield* body({ accounts, provider, states, start, logged: logs.logged });
    }).pipe(Effect.provide(runtime));
  }).pipe(Effect.provideService(References.MinimumLogLevel, "Debug"));

layer(BunFileSystem.layer)("UsagePoll, for opencode Go accounts", (it) => {
  it.effect("cools an account down at startup until its used-up window resets", () =>
    withPoll(
      ["sk-1", "sk-2"],
      (provider, start) => {
        provider.usageFor("sk-1", weekly(100, start + POLL_MS * 10));
        provider.usageFor("sk-2", weekly(40, start + POLL_MS * 10));
      },
      ({ accounts, states, start }) =>
        Effect.gen(function* () {
          expect(yield* states.get).toEqual({
            [accounts[0]?.id ?? ""]: {
              status: "cooling",
              until: start + POLL_MS * 10,
              reason: "usage_exhausted",
            },
          });
        }),
    ),
  );

  it.effect("cools an account down once a later pass finds its window used up", () =>
    withPoll(
      ["sk-1"],
      (provider, start) => provider.usageFor("sk-1", weekly(10, start + POLL_MS * 10)),
      ({ accounts, provider, states, start, logged }) =>
        Effect.gen(function* () {
          provider.usageFor("sk-1", weekly(100, start + POLL_MS * 10));
          yield* TestClock.adjust(POLL_MS);
          yield* logged("go-sk-1 is cooling down");
          expect((yield* states.get)[accounts[0]?.id ?? ""]).toMatchObject({ status: "cooling" });
        }),
    ),
  );

  it.effect("leaves an account alone when its usage can't be read", () =>
    withPoll(
      ["sk-1"],
      (provider) => provider.usageFor("sk-1", { error: "unauthorized" }, 401),
      ({ states }) =>
        Effect.gen(function* () {
          expect(yield* states.get).toEqual({});
        }),
    ),
  );
});
