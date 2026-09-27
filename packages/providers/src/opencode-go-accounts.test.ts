import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it as test, layer } from "@effect/vitest";
import { Effect, FileSystem, Option, Redacted, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  DuplicateOpencodeGoKeyError,
  maskKey,
  OpencodeGoAccountNotFoundError,
  OpencodeGoAccounts,
} from "./index.ts";

const withAccounts = <A, E>(
  body: (file: string) => Effect.Effect<A, E, OpencodeGoAccounts | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${yield* fs.makeTempDirectoryScoped()}/opencode-go.json`;

    return yield* body(file).pipe(Effect.provide(OpencodeGoAccounts.layer(file)));
  });

const key = (value: string) => Redacted.make(value);

/** An account as the store's file holds it, its key as its id too. */
const stored = (label: string, apiKey: string) => ({
  id: apiKey,
  label,
  apiKey,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
});

layer(BunFileSystem.layer)("OpencodeGoAccounts", (it) => {
  it.effect("adds an enabled account under the label it is given", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const store = yield* OpencodeGoAccounts;
        const added = yield* store.add(key("sk-go-1234"), "work");
        expect(added).toMatchObject({ label: "work", enabled: true });
        expect(Redacted.value(added.apiKey)).toBe("sk-go-1234");
        expect(yield* store.list).toEqual([added]);
      }),
    ),
  );

  it.effect("labels an account by its key's last four characters when given no label", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const added = yield* (yield* OpencodeGoAccounts).add(key("sk-go-abcd"));
        expect(added.label).toBe("OpenCode Go …abcd");
      }),
    ),
  );

  it.effect("lists accounts in the order they were added", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const store = yield* OpencodeGoAccounts;
        yield* store.add(key("sk-1"), "first");
        yield* TestClock.adjust("1 second");
        yield* store.add(key("sk-2"), "second");
        expect((yield* store.list).map(({ label }) => label)).toEqual(["first", "second"]);
      }),
    ),
  );

  it.effect("refuses a key it already stores", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const store = yield* OpencodeGoAccounts;
        const first = yield* store.add(key("sk-1"), "first");
        const again = yield* store.add(key("sk-1"), "again").pipe(Effect.flip);
        expect(again).toEqual(new DuplicateOpencodeGoKeyError({ label: first.label }));
      }),
    ),
  );

  it.effect("imports a key from the environment once, as an account marked imported", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const store = yield* OpencodeGoAccounts;
        const imported = yield* store.importKey(key("sk-env"));
        expect(Option.map(imported, ({ label }) => label)).toEqual(
          Option.some("OpenCode Go (imported)"),
        );
        expect(yield* store.importKey(key("sk-env"))).toEqual(Option.none());
        expect(yield* store.list).toHaveLength(1);
      }),
    ),
  );

  it.effect("does not import a key already stored under another label", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const store = yield* OpencodeGoAccounts;
        yield* store.add(key("sk-env"), "mine");
        expect(yield* store.importKey(key("sk-env"))).toEqual(Option.none());
        expect((yield* store.list).map(({ label }) => label)).toEqual(["mine"]);
      }),
    ),
  );

  it.effect("renames labels via gave under OpenCode Go's old spelling, not the user's own", () =>
    withAccounts((file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        yield* fs.writeFileString(
          file,
          JSON.stringify([
            stored("opencode Go (imported)", "sk-env"),
            stored("opencode Go …abcd", "sk-go-abcd"),
            // Not this key's default: the user typed it.
            stored("opencode Go …wxyz", "sk-go-1234"),
            stored("my opencode Go", "sk-go-5678"),
          ]),
        );

        const store = yield* OpencodeGoAccounts;
        const labels = ["OpenCode Go (imported)", "OpenCode Go …abcd"];
        const kept = ["opencode Go …wxyz", "my opencode Go"];
        expect((yield* store.list).map(({ label }) => label)).toEqual([...labels, ...kept]);

        // Written back with the next change.
        yield* store.setEnabled("sk-go-5678", false);
        const onDisk = yield* fs.readFileString(file);
        expect(onDisk).toContain(labels[0]);
        expect(onDisk).not.toContain("opencode Go (imported)");
      }),
    ),
  );

  it.effect("keeps the file readable only by the owner", () =>
    withAccounts((file) =>
      Effect.gen(function* () {
        yield* (yield* OpencodeGoAccounts).add(key("sk-1"));
        expect((yield* (yield* FileSystem.FileSystem).stat(file)).mode & 0o777).toBe(0o600);
      }),
    ),
  );

  it.effect("reads what another store wrote to the same file", () =>
    withAccounts((file) =>
      Effect.gen(function* () {
        const added = yield* (yield* OpencodeGoAccounts).add(key("sk-1"), "shared");

        const listed = yield* Effect.provide(
          Effect.flatMap(OpencodeGoAccounts, (other) => other.list),
          OpencodeGoAccounts.layer(file),
        );

        expect(listed).toEqual([added]);
      }),
    ),
  );

  it.effect("finds an account by id or label, the id first", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const store = yield* OpencodeGoAccounts;
        const first = yield* store.add(key("sk-1"), "first");
        yield* TestClock.adjust("1 second");
        const second = yield* store.add(key("sk-2"), first.id);
        expect(yield* store.find(first.id)).toEqual(first);
        expect(yield* store.find("first")).toEqual(first);
        expect((yield* store.list).at(-1)).toEqual(second);
      }),
    ),
  );

  it.effect("fails to find an account nothing matches", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const missing = yield* (yield* OpencodeGoAccounts).find("nope").pipe(Effect.flip);
        expect(missing).toEqual(new OpencodeGoAccountNotFoundError({ query: "nope" }));
      }),
    ),
  );

  it.effect("labels, disables, enables and removes an account", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const store = yield* OpencodeGoAccounts;
        const { id } = yield* store.add(key("sk-1"), "first");
        yield* store.setLabel("first", "renamed");
        yield* store.setEnabled("renamed", false);
        expect(yield* store.find(id)).toMatchObject({ label: "renamed", enabled: false });
        yield* store.setEnabled(id, true);
        expect((yield* store.find(id)).enabled).toBe(true);
        yield* store.remove("renamed");
        expect(yield* store.list).toEqual([]);
      }),
    ),
  );

  it.effect("does not show the key when an account is printed", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const added = yield* (yield* OpencodeGoAccounts).add(key("sk-secret-1234"));
        expect(JSON.stringify(added)).not.toContain("sk-secret");
        expect(String(added.apiKey)).not.toContain("sk-secret");
      }),
    ),
  );

  it.effect("signals now, then after every change it makes, but not when read", () =>
    withAccounts(() =>
      Effect.gen(function* () {
        const store = yield* OpencodeGoAccounts;
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
        const { id } = yield* store.add(key("sk-go-1234"), "work");
        yield* store.list;
        yield* store.find(id);
        expect(yield* settled).toBe(2);
        yield* store.setLabel(id, "home");
        yield* store.setEnabled(id, false);
        yield* store.remove(id);
        expect(yield* settled).toBe(5);
      }),
    ),
  );
});

describe("maskKey", () => {
  test("shows only a key's last four characters", () => {
    expect(maskKey(key("sk-go-abcdef"))).toBe("…cdef");
  });
});
