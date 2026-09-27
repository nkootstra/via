import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { CorruptFileError } from "@via/config";
import { Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { tokensFor } from "./testing/index.ts";
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
        const saved = yield* store.save(tokensFor("a"));
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
        const first = yield* store.save(tokensFor("a", { refreshToken: "rt-old" }));
        yield* store.setLabel(first.id, "work");
        yield* store.setEnabled("work", false);
        yield* store.save(tokensFor("a", { refreshToken: "rt-new" }));
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
        const first = yield* store.save(tokensFor("a", { refreshToken: "rt-old" }));
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
        const saved = yield* store.save(tokensFor("a"));
        yield* store.setLabel(saved.id, "work");
        expect(yield* store.find("a@example.com")).toEqual({ ...saved, label: "work" });
      }),
    ),
  );

  it.effect("an id finds its own account, even when another account has it as its label", () =>
    withAccountStore(() =>
      Effect.gen(function* () {
        const store = yield* AccountStore;
        const a = yield* store.save(tokensFor("a"));
        yield* TestClock.adjust("1 second");
        const b = yield* store.save(tokensFor("b"));
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
        const { id } = yield* (yield* AccountStore).save(tokensFor("a"));
        expect(((yield* fs.stat(`${authDir}/${id}.json`)).mode & 0o777).toString(8)).toBe("600");
      }),
    ),
  );

  it.effect("skips files that are not account JSON, such as a write's leftover temp file", () =>
    withAccountStore((authDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* AccountStore;
        const saved = yield* store.save(tokensFor("a"));
        yield* fs.writeFileString(`${authDir}/${saved.id}.json.123.tmp`, "{");
        expect(yield* store.list).toEqual([saved]);
      }),
    ),
  );

  it.effect("fails with CorruptFileError naming an account file it cannot read", () =>
    withAccountStore((authDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(authDir, { recursive: true });
        yield* fs.writeFileString(`${authDir}/broken.json`, '{"id": "broken"}');
        const error = yield* Effect.flip((yield* AccountStore).list);
        expect(error).toBeInstanceOf(CorruptFileError);
        expect(error).toMatchObject({ path: `${authDir}/broken.json` });
      }),
    ),
  );
});
