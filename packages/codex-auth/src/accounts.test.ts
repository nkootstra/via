import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { jwt } from "./fake-issuer.ts";
import { AccountNotFoundError, AccountStore, type Tokens } from "./index.ts";

const tokensFor = (email: string, accountId: string, refreshToken = "rt"): Tokens => ({
  idToken: jwt({
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
  }),
  accessToken: "at",
  refreshToken,
  expiresAt: 1_000,
});

const withAccountStore = <A, E>(
  body: (authDir: string) => Effect.Effect<A, E, AccountStore | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const authDir = `${yield* fs.makeTempDirectoryScoped()}/auth`;

    return yield* body(authDir).pipe(Effect.provide(AccountStore.layer(authDir)));
  });

layer(BunFileSystem.layer)("AccountStore", (it) => {
  it.effect("has no accounts before the first login creates the auth directory", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        expect(yield* (yield* AccountStore).list).toEqual([]);
      }),
    ),
  );

  it.effect("saves a logged-in account with identity from its ID token", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const saved = yield* store.save(tokensFor("a@example.com", "acc-a"));
        expect(saved).toMatchObject({
          label: "a@example.com",
          email: "a@example.com",
          accountId: "acc-a",
          plan: "plus",
          enabled: true,
        });
        expect(yield* store.list).toEqual([saved]);
      }),
    ),
  );

  it.effect("logging in to the same account again replaces its tokens and keeps its settings", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const first = yield* store.save(tokensFor("a@example.com", "acc-a", "rt-old"));
        yield* store.setLabel(first.id, "work");
        yield* store.setEnabled("work", false);
        yield* store.save(tokensFor("a@example.com", "acc-a", "rt-new"));
        expect(yield* store.list).toEqual([
          { ...first, label: "work", enabled: false, refreshToken: "rt-new" },
        ]);
      }),
    ),
  );

  it.effect("a label change during a token refresh keeps both", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const first = yield* store.save(tokensFor("a@example.com", "acc-a", "rt-old"));
        yield* Effect.all(
          [
            store.save(tokensFor("a@example.com", "acc-a", "rt-new")),
            store.setLabel(first.id, "work"),
          ],
          { concurrency: "unbounded", discard: true },
        );
        expect(yield* store.list).toEqual([{ ...first, label: "work", refreshToken: "rt-new" }]);
      }),
    ),
  );

  it.effect("lists accounts in the order they were added", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        yield* store.save(tokensFor("b@example.com", "acc-b"));
        yield* TestClock.adjust("1 second");
        yield* store.save(tokensFor("a@example.com", "acc-a"));
        expect((yield* store.list).map((a) => a.email)).toEqual(["b@example.com", "a@example.com"]);
      }),
    ),
  );

  it.effect("removes an account by email", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        yield* store.save(tokensFor("a@example.com", "acc-a"));
        yield* store.remove("a@example.com");
        expect(yield* store.list).toEqual([]);
      }),
    ),
  );

  it.effect("an id finds its own account, even when another account has it as its label", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const a = yield* store.save(tokensFor("a@example.com", "acc-a"));
        yield* TestClock.adjust("1 second");
        const b = yield* store.save(tokensFor("b@example.com", "acc-b"));
        yield* store.setLabel(a.id, b.id);
        expect(yield* store.find(b.id)).toEqual(b);
      }),
    ),
  );

  it.effect("fails with AccountNotFoundError for an unknown account", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* AccountStore).remove("nobody"));
        expect(error).toEqual(new AccountNotFoundError({ query: "nobody" }));
      }),
    ),
  );

  it.effect("keeps each account in its own owner-only file", () =>
    withAccountStore((authDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { id } = yield* (yield* AccountStore).save(tokensFor("a@example.com", "acc-a"));
        expect(((yield* fs.stat(`${authDir}/${id}.json`)).mode & 0o777).toString(8)).toBe("600");
      }),
    ),
  );
});
