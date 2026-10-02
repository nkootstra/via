import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { seedAccount, tokensFor } from "./testing/index.ts";
import { AccountNotFoundError, AccountStore } from "./index.ts";

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
        const { account: saved, created } = yield* store.save(tokensFor("a"));
        expect(created).toBe(true);
        expect(saved).toMatchObject({
          label: "a@example.com",
          email: "a@example.com",
          accountId: "acc-a",
          plan: "pro",
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
        const { account: first } = yield* store.save(tokensFor("a", { refreshToken: "rt-old" }));
        yield* store.setLabel(first.id, "work");
        yield* store.setEnabled("work", false);
        const again = yield* store.save(tokensFor("a", { refreshToken: "rt-new" }));
        const updated = { ...first, label: "work", enabled: false, refreshToken: "rt-new" };
        expect(again).toEqual({ account: updated, created: false });
        expect(yield* store.list).toEqual([updated]);
      }),
    ),
  );

  it.effect("a label change during a token refresh keeps both", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const { account: first } = yield* store.save(tokensFor("a", { refreshToken: "rt-old" }));
        yield* Effect.all(
          [
            store.save(tokensFor("a", { refreshToken: "rt-new" })),
            store.setLabel(first.id, "work"),
          ],
          { concurrency: "unbounded", discard: true },
        );
        expect(yield* store.list).toEqual([{ ...first, label: "work", refreshToken: "rt-new" }]);
      }),
    ),
  );

  it.effect("a label change in one process during a token refresh in another keeps both", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const authDir = `${yield* fs.makeTempDirectoryScoped()}/auth`;
      const names = ["a", "b", "c", "d", "e", "f"];
      yield* Effect.forEach(names, (name) => seedAccount(authDir, name));

      // Two layers are two stores, each with its own in-process lock, as `via accounts label`
      // and a running `via serve` refreshing tokens are.
      const storeAt = Layer.build(AccountStore.layer(authDir)).pipe(
        Effect.map(Context.get(AccountStore)),
      );

      const cli = yield* storeAt;
      const serve = yield* storeAt;

      // Live time: a store waiting on the other's lock file polls for it in real time.
      yield* TestClock.withLive(
        Effect.forEach(
          names,
          (name) =>
            Effect.all(
              [
                cli.setLabel(name, `work-${name}`),
                serve.saveRefreshed(name, tokensFor(name, { refreshToken: "rt-new" })),
              ],
              { concurrency: "unbounded", discard: true },
            ),
          { concurrency: "unbounded", discard: true },
        ),
      );

      // Every seeded account has the same createdAt, so list's order among them is arbitrary.
      const accounts = (yield* serve.list).toSorted((a, b) => a.id.localeCompare(b.id));

      expect(accounts.map((a) => [a.label, a.refreshToken])).toEqual(
        names.map((name) => [`work-${name}`, "rt-new"]),
      );
    }),
  );

  it.effect("lists accounts in the order they were added", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        yield* store.save(tokensFor("b"));
        yield* TestClock.adjust("1 second");
        yield* store.save(tokensFor("a"));
        expect((yield* store.list).map((a) => a.email)).toEqual(["b@example.com", "a@example.com"]);
      }),
    ),
  );

  it.effect("removes an account by email", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        yield* store.save(tokensFor("a"));
        yield* store.remove("a@example.com");
        expect(yield* store.list).toEqual([]);
      }),
    ),
  );

  it.effect("finds an account by its email after its label has changed", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const { account: saved } = yield* store.save(tokensFor("a"));
        yield* store.setLabel(saved.id, "work");
        expect(yield* store.find("a@example.com")).toEqual({ ...saved, label: "work" });
      }),
    ),
  );

  it.effect("an id finds its own account, even when another account has it as its label", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const { account: a } = yield* store.save(tokensFor("a"));
        yield* TestClock.adjust("1 second");
        const { account: b } = yield* store.save(tokensFor("b"));
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
        const { id } = (yield* (yield* AccountStore).save(tokensFor("a"))).account;
        expect(((yield* fs.stat(`${authDir}/${id}.json`)).mode & 0o777).toString(8)).toBe("600");
      }),
    ),
  );

  it.effect("skips files that are not account JSON, such as a write's leftover temp file", () =>
    withAccountStore((authDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* AccountStore;
        const { account: saved } = yield* store.save(tokensFor("a"));
        yield* fs.writeFileString(`${authDir}/${saved.id}.json.123.tmp`, "{");
        expect(yield* store.list).toEqual([saved]);
      }),
    ),
  );

  it.effect("skips an account file it cannot read, so the other accounts keep serving", () =>
    withAccountStore((authDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* AccountStore;
        const { account: saved } = yield* store.save(tokensFor("a"));
        yield* fs.writeFileString(`${authDir}/broken.json`, '{"id": "broken"}');
        expect(yield* store.list).toEqual([saved]);
        expect(yield* store.find(saved.id)).toEqual(saved);
      }),
    ),
  );

  it.effect("skips an account file removed while it lists them, as another process may", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const authDir = `${yield* fs.makeTempDirectoryScoped()}/auth`;
      yield* seedAccount(authDir, "a");

      // The directory still names an account whose file is gone by the time it is read.
      const removedMidList = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        readDirectory: (path, options) =>
          Effect.map(fs.readDirectory(path, options), (names) => [...names, "gone.json"]),
      });

      const accounts = yield* Effect.flatMap(AccountStore, (store) => store.list).pipe(
        Effect.provide(AccountStore.layer(authDir).pipe(Layer.provide(removedMidList))),
      );

      expect(accounts.map((a) => a.id)).toEqual(["a"]);
    }),
  );

  it.effect("signals now, then after every change it makes, but not when read", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const signals = yield* Ref.make(0);
        yield* store.changes.pipe(
          Stream.runForEach(() => Ref.update(signals, (n) => n + 1)),
          Effect.forkChild,
        );

        const settled = Effect.andThen(
          Effect.repeat(Effect.yieldNow, { times: 20 }),
          Ref.get(signals),
        );

        expect(yield* settled).toBe(1);
        const { id } = (yield* store.save(tokensFor("a"))).account;
        yield* store.list;
        yield* store.find(id);
        expect(yield* settled).toBe(2);
        yield* store.setLabel(id, "work");
        yield* store.setEnabled(id, false);
        yield* store.saveRefreshed(id, tokensFor("a", { refreshToken: "rt-new" }));
        yield* store.remove(id);
        expect(yield* settled).toBe(6);
      }),
    ),
  );
});
