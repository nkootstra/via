import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { tokensFor } from "@via/codex-auth/testing";
import { CodexUpstream } from "@via/codex-upstream";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { OpencodeGoAccounts, Providers } from "@via/providers";
import { startFakeProvider } from "@via/providers/testing";
import { Clock, Effect, Fiber, FileSystem, Layer, Redacted, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { UsageSnapshots } from "./usage-snapshots.ts";

/**
 * Runs `body` with `UsageSnapshots` over accounts "a" and "b" (in that order), a
 * fake Codex, a fake OpenCode Go with one account, `go-1`, and OpenRouter with the key
 * `sk-or`, played by the same fake. Nothing refreshes on its own.
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
        providers: {
          "opencode-go": { baseUrl: provider.url, apiKeyEnv: "PROVIDER_KEY" },
          openrouter: { baseUrl: provider.url, apiKeyEnv: "OPENROUTER_KEY" },
        },
        apiKeys: { openrouter: Redacted.make("sk-or") },
        version: "0.0.0",
      }).pipe(Layer.provideMerge(OpencodeGoAccounts.layer(`${dir}/opencode-go.json`))),
    ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(BunFileSystem.layer));

    const built = yield* Layer.build(UsageSnapshots.layer.pipe(Layer.provideMerge(services)));

    return yield* Effect.gen(function* () {
      const store = yield* AccountStore;
      yield* store.save(tokensFor("a"));
      // Accounts are listed in the order they were added, so "a" must come first.
      yield* TestClock.adjust("1 second");
      yield* store.save(tokensFor("b"));
      yield* (yield* OpencodeGoAccounts).add(Redacted.make("sk-provider"), "go-1");

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
        expect(yield* snapshots.get).toEqual({ accounts: [], opencodeGo: [], openrouter: null });
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
        expect(
          stored.opencodeGo.map(({ account, ...rest }) => ({ label: account.label, ...rest })),
        ).toEqual([{ label: "go-1", fetchedAt: now, windows: [] }]);
      }),
    ),
  );

  it.effect("says in words why an answer it can't read gave no usage, not the parser's error", () =>
    withSnapshots(({ snapshots, codex, provider }) =>
      Effect.gen(function* () {
        codex.usage("acc-b", { rate_limit: "full" });
        provider.usage({ usage: "full" });
        yield* snapshots.refresh;
        const stored = yield* snapshots.get;

        expect(stored.accounts.map((usage) => ("error" in usage ? usage.error : "ok"))).toEqual([
          "ok",
          "ChatGPT's usage answer couldn't be read",
        ]);
        expect(stored.opencodeGo.map((usage) => ("error" in usage ? usage.error : "ok"))).toEqual([
          "opencode-go's usage answer couldn't be read",
        ]);
      }),
    ),
  );

  it.effect("keeps OpenRouter's budget, or why it couldn't be read, and when", () =>
    withSnapshots(({ snapshots, codex, provider }) =>
      Effect.gen(function* () {
        codex.usage("acc-b", {}, 403);
        provider.usage({ usage: {} });
        const now = yield* Clock.currentTimeMillis;

        yield* snapshots.refresh;
        expect((yield* snapshots.get).openrouter).toEqual({
          fetchedAt: now,
          error: "OpenRouter refused its key (HTTP 401)",
        });

        provider.openrouterKey("sk-or", { limit: 10, limit_remaining: 4, limit_reset: null });
        yield* snapshots.refresh;
        expect((yield* snapshots.get).openrouter).toEqual({
          fetchedAt: now,
          budget: { limitUsd: 10, spentUsd: 6, window: null, resetsAt: null },
        });
      }),
    ),
  );

  it.effect("signals at once, then when a refresh starts and once what it fetched is kept", () =>
    withSnapshots(({ snapshots }) =>
      Effect.gen(function* () {
        const seen = yield* snapshots.changes.pipe(
          Stream.mapEffect(() => Effect.map(snapshots.get, (kept) => kept.accounts.length)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Effect.yieldNow;
        yield* snapshots.refresh;

        expect(yield* Fiber.join(seen)).toEqual([0, 0, 2]);
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
    it.effect("answers at once with nothing kept yet, and refreshes in the background", () =>
      withSnapshots(({ snapshots }) =>
        Effect.gen(function* () {
          expect(yield* snapshots.latest).toEqual({
            accounts: [],
            opencodeGo: [],
            openrouter: null,
            refreshing: true,
          });
          const done = yield* snapshots.refresh;
          expect(yield* snapshots.latest).toEqual({ ...done, refreshing: false });
        }),
      ),
    );

    it.effect("answers what it holds, without asking again, for a minute", () =>
      withSnapshots(({ snapshots, codex, provider }) =>
        Effect.gen(function* () {
          const first = yield* snapshots.refresh;
          yield* TestClock.adjust("59 seconds");
          expect(yield* snapshots.latest).toEqual({ ...first, refreshing: false });
          expect(codex.requests).toHaveLength(2);
          expect(provider.usageRequests).toHaveLength(1);
        }),
      ),
    );

    it.effect("answers what it holds once a minute old, and refreshes it in the background", () =>
      withSnapshots(({ snapshots, codex, provider }) =>
        Effect.gen(function* () {
          const first = yield* snapshots.refresh;
          yield* TestClock.adjust("1 minute");
          expect(yield* snapshots.latest).toEqual({ ...first, refreshing: true });
          yield* eventually(Effect.sync(() => provider.usageRequests.length === 2));
          expect(codex.requests).toHaveLength(4);
          const now = yield* Clock.currentTimeMillis;
          yield* eventually(
            Effect.map(snapshots.get, ({ opencodeGo }) => opencodeGo[0]?.fetchedAt === now),
          );
        }),
      ),
    );

    it.effect("refreshes in the background when an account was added since the last refresh", () =>
      withSnapshots(({ snapshots, store }) =>
        Effect.gen(function* () {
          yield* snapshots.refresh;
          yield* TestClock.adjust("1 second");
          yield* store.save(tokensFor("c"));
          const latest = yield* snapshots.latest;
          expect(latest.refreshing).toBe(true);
          expect(latest.accounts.map(({ account }) => account.label)).toEqual([
            "a@example.com",
            "b@example.com",
          ]);
          yield* eventually(Effect.map(snapshots.get, ({ accounts }) => accounts.length === 3));
          expect((yield* snapshots.latest).accounts.map(({ account }) => account.label)).toEqual([
            "a@example.com",
            "b@example.com",
            "c@example.com",
          ]);
        }),
      ),
    );

    it.effect("leaves out an account removed since the last refresh, and shows its new label", () =>
      withSnapshots(({ snapshots, store }) =>
        Effect.gen(function* () {
          const [a, b] = (yield* snapshots.refresh).accounts;
          yield* store.remove(a?.account.id ?? "");
          yield* store.setLabel(b?.account.id ?? "", "work");
          const latest = yield* snapshots.latest;
          expect(latest.refreshing).toBe(false);
          expect(latest.accounts.map(({ account }) => account.label)).toEqual(["work"]);
          expect(latest.accounts[0]?.fetchedAt).toBe(b?.fetchedAt);
        }),
      ),
    );
  });
});
