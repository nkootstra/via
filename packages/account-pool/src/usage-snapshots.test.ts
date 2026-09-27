import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { tokensFor } from "@via/codex-auth/testing";
import { CodexUpstream } from "@via/codex-upstream";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { Providers } from "@via/providers";
import { startFakeProvider } from "@via/providers/testing";
import { Clock, Effect, Fiber, FileSystem, Layer, Redacted, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { UsageSnapshots } from "./usage-snapshots.ts";

/**
 * Runs `body` with `UsageSnapshots` over accounts "a" and "b" (in that order), a
 * fake Codex and a fake provider named `opencode-go`. Nothing refreshes on its own.
 */
const withSnapshots = <A, E>(
  body: (args: {
    snapshots: UsageSnapshots["Service"];
    codex: Effect.Success<typeof startFakeCodex>;
    provider: Effect.Success<typeof startFakeProvider>;
    store: AccountStore["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const codex = yield* startFakeCodex;
    const provider = yield* startFakeProvider;

    const services = Layer.mergeAll(
      AccountTokens.layer.pipe(
        Layer.provide(CodexAuth.layer("http://127.0.0.1:1")),
        Layer.provideMerge(AccountStore.layer(`${dir}/auth`)),
      ),
      CodexUpstream.layer({ baseUrl: codex.url, cloak: true, version: "0.0.0" }),
      Providers.layer({
        providers: { "opencode-go": { baseUrl: provider.url, apiKeyEnv: "PROVIDER_KEY" } },
        apiKeys: { "opencode-go": Redacted.make("sk-provider") },
        version: "0.0.0",
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(BunFileSystem.layer));

    const built = yield* Layer.build(UsageSnapshots.layer.pipe(Layer.provideMerge(services)));

    return yield* Effect.gen(function* () {
      const store = yield* AccountStore;
      yield* store.save(tokensFor("a"));
      // Accounts are listed in the order they were added, so "a" must come first.
      yield* TestClock.adjust("1 second");
      yield* store.save(tokensFor("b"));

      return yield* body({ snapshots: yield* UsageSnapshots, codex, provider, store });
    }).pipe(Effect.provide(built));
  }).pipe(Effect.provide(BunFileSystem.layer));

/** Waits, in real time, until `check` holds: for a refresh running in the background. */
const eventually = (check: Effect.Effect<boolean>) =>
  TestClock.withLive(
    Effect.sleep("5 millis").pipe(
      Effect.andThen(check),
      Effect.repeat({ until: (done) => done, schedule: Schedule.recurs(400) }),
    ),
  );

describe("UsageSnapshots", () => {
  it.effect("holds nothing before the first refresh, without waiting for one", () =>
    withSnapshots(({ snapshots, codex }) =>
      Effect.gen(function* () {
        expect(yield* snapshots.get).toEqual({ accounts: [], providers: undefined });
        expect(codex.requests).toHaveLength(0);
      }),
    ),
  );

  it.effect("keeps each account's and provider's usage, or why it is unavailable, and when", () =>
    withSnapshots(({ snapshots, codex, provider }) =>
      Effect.gen(function* () {
        codex.usage("acc-b", {}, 403);
        provider.usage({ usage: {} });
        const now = yield* Clock.currentTimeMillis;
        yield* snapshots.refresh;
        const stored = yield* snapshots.get;
        expect(
          stored.accounts.map(({ account, ...rest }) => ({ label: account.label, ...rest })),
        ).toEqual([
          {
            label: "a@example.com",
            fetchedAt: now,
            windows: [
              { windowMinutes: 300, usedPercent: 12, resetsAt: 1_700_003_600_000 },
              { windowMinutes: 10_080, usedPercent: 40, resetsAt: 1_700_086_400_000 },
            ],
          },
          {
            label: "b@example.com",
            fetchedAt: now,
            error: "ChatGPT did not report usage (HTTP 403)",
          },
        ]);
        expect(stored.providers).toEqual({
          fetchedAt: now,
          reports: [{ provider: "opencode-go", windows: [] }],
        });
      }),
    ),
  );

  it.effect("joins a refresh already running instead of starting another", () =>
    withSnapshots(({ snapshots, codex, provider }) =>
      Effect.gen(function* () {
        const fibers = yield* Effect.forEach([1, 2, 3], () => Effect.forkChild(snapshots.refresh));
        const results = yield* Fiber.joinAll(fibers);
        expect(codex.requests).toHaveLength(2);
        expect(provider.usageRequests).toHaveLength(1);
        expect(results[1]).toBe(results[0]);
        expect(results[2]).toBe(results[0]);

        // Once it is done, the next refresh asks again.
        yield* snapshots.refresh;
        expect(codex.requests).toHaveLength(4);
      }),
    ),
  );

  it.effect("finishes a refresh whose caller gave up waiting", () =>
    withSnapshots(({ snapshots }) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(snapshots.refresh);
        yield* Fiber.interrupt(fiber);
        const joined = yield* snapshots.refresh;
        expect(joined.accounts).toHaveLength(2);
        expect((yield* snapshots.get).accounts).toHaveLength(2);
      }),
    ),
  );

  describe("latest", () => {
    it.effect("waits for a refresh when none has finished yet", () =>
      withSnapshots(({ snapshots, codex }) =>
        Effect.gen(function* () {
          const latest = yield* snapshots.latest;
          expect(latest.accounts).toHaveLength(2);
          expect(latest.providers).toBeDefined();
          expect(codex.requests).toHaveLength(2);
        }),
      ),
    );

    it.effect("answers what it holds, without asking again, for a minute", () =>
      withSnapshots(({ snapshots, codex, provider }) =>
        Effect.gen(function* () {
          const first = yield* snapshots.latest;
          yield* TestClock.adjust("59 seconds");
          expect(yield* snapshots.latest).toEqual(first);
          expect(codex.requests).toHaveLength(2);
          expect(provider.usageRequests).toHaveLength(1);
        }),
      ),
    );

    it.effect("answers what it holds once a minute old, and refreshes it in the background", () =>
      withSnapshots(({ snapshots, codex, provider }) =>
        Effect.gen(function* () {
          const first = yield* snapshots.latest;
          yield* TestClock.adjust("1 minute");
          expect(yield* snapshots.latest).toEqual(first);
          yield* eventually(Effect.sync(() => provider.usageRequests.length === 2));
          expect(codex.requests).toHaveLength(4);
          const now = yield* Clock.currentTimeMillis;
          yield* eventually(
            Effect.map(snapshots.get, ({ providers }) => providers?.fetchedAt === now),
          );
        }),
      ),
    );

    it.effect("waits for a refresh when an account was added since the last one", () =>
      withSnapshots(({ snapshots, codex, store }) =>
        Effect.gen(function* () {
          yield* snapshots.latest;
          yield* TestClock.adjust("1 second");
          yield* store.save(tokensFor("c"));
          const latest = yield* snapshots.latest;
          expect(latest.accounts.map(({ account }) => account.label)).toEqual([
            "a@example.com",
            "b@example.com",
            "c@example.com",
          ]);
          expect(codex.requests).toHaveLength(5);
        }),
      ),
    );

    it.effect("leaves out an account removed since the last refresh, and shows its new label", () =>
      withSnapshots(({ snapshots, store }) =>
        Effect.gen(function* () {
          const before = yield* snapshots.latest;
          const [a, b] = before.accounts;
          yield* store.remove(a?.account.id ?? "");
          yield* store.setLabel(b?.account.id ?? "", "work");
          const latest = yield* snapshots.latest;
          expect(latest.accounts.map(({ account }) => account.label)).toEqual(["work"]);
          expect(latest.accounts[0]?.fetchedAt).toBe(b?.fetchedAt);
        }),
      ),
    );
  });
});
