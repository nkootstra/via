import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { issuedTokens, refreshedTokens, withIssuer } from "./fake-issuer.ts";
import { type Account, AccountStore, AccountTokens } from "./index.ts";

const MINUTE = 60_000;

/** Stores an account whose access token expires at `expiresAt` (TestClock starts at 0). */
const withAccount = <A, E>(
  expiresAt: number,
  body: (account: Account) => Effect.Effect<A, E, AccountTokens | AccountStore>,
) =>
  withIssuer({}, () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      return yield* Effect.gen(function* () {
        const account = yield* (yield* AccountStore).save({
          idToken: issuedTokens.id_token,
          accessToken: issuedTokens.access_token,
          refreshToken: "rt-1",
          expiresAt,
        });
        return yield* body(account);
      }).pipe(
        Effect.provide(AccountTokens.layer.pipe(Layer.provideMerge(AccountStore.layer(dir)))),
      );
    }),
  );

layer(BunFileSystem.layer)("AccountTokens.fresh", (it) => {
  it.effect("uses the stored access token while it stays valid for over 5 minutes", () =>
    withAccount(6 * MINUTE, (account) =>
      Effect.gen(function* () {
        const fresh = yield* (yield* AccountTokens).fresh(account);
        expect(fresh.accessToken).toBe(issuedTokens.access_token);
      }),
    ),
  );

  it.effect("refreshes a token that expires within 5 minutes and saves the rotation", () =>
    withAccount(4 * MINUTE, (account) =>
      Effect.gen(function* () {
        const fresh = yield* (yield* AccountTokens).fresh(account);
        expect(fresh.accessToken).toBe(refreshedTokens.access_token);
        expect((yield* (yield* AccountStore).find(account.id)).refreshToken).toBe("rt-2");
      }),
    ),
  );

  it.effect("concurrent callers share one refresh, so the refresh token is used once", () =>
    withAccount(0, (account) =>
      Effect.gen(function* () {
        const tokens = yield* AccountTokens;
        const results = yield* Effect.all(
          Array.from({ length: 3 }, () => tokens.fresh(account)),
          { concurrency: "unbounded" },
        );
        expect(results.map((a) => a.accessToken)).toEqual(
          Array(3).fill(refreshedTokens.access_token),
        );
      }),
    ),
  );

  it.effect("refreshes a token that upstream rejected even though it has not expired", () =>
    withAccount(60 * MINUTE, (account) =>
      Effect.gen(function* () {
        const tokens = yield* AccountTokens;
        const fresh = yield* tokens.refreshRejected(account.id, account.accessToken);
        expect(fresh.accessToken).toBe(refreshedTokens.access_token);
      }),
    ),
  );

  it.effect("does not refresh again when the rejected token was already replaced", () =>
    withAccount(60 * MINUTE, (account) =>
      Effect.gen(function* () {
        const tokens = yield* AccountTokens;
        yield* tokens.refreshRejected(account.id, account.accessToken);
        const again = yield* tokens.refreshRejected(account.id, account.accessToken);
        expect(again.accessToken).toBe(refreshedTokens.access_token);
      }),
    ),
  );

  it.effect("keeps the account's identity and settings when refreshing", () =>
    withAccount(0, (account) =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        yield* store.setLabel(account.id, "work");
        yield* (yield* AccountTokens).fresh(account);
        expect(yield* store.list).toEqual([
          expect.objectContaining({ id: account.id, label: "work", refreshToken: "rt-2" }),
        ]);
      }),
    ),
  );
});
