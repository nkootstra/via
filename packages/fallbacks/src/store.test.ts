import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { CorruptFileError } from "@via/config";
import { Context, Effect, FileSystem, Layer, Queue, type Scope, Stream } from "effect";
import { FallbackRuleNotFoundError, FallbackRuleStore } from "./index.ts";

const sol = { model: "gpt-5.6-sol", fallbacks: ["opencode-go/kimi-k3", "gpt-5.5"] };

const luna = { model: "gpt-5.6-luna", fallbacks: ["gpt-5.5"] };

/** A file for rules in a fresh directory, and a store over it, as another process would open one. */
const storeAt = (file: string) =>
  Effect.map(Layer.build(FallbackRuleStore.layer(file)), (context) =>
    Context.get(context, FallbackRuleStore),
  );

const withStore = <A, E>(
  body: (
    store: FallbackRuleStore["Service"],
    file: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${yield* fs.makeTempDirectoryScoped()}/fallbacks.json`;

    return yield* body(yield* storeAt(file), file);
  });

layer(BunFileSystem.layer)("FallbackRuleStore", (it) => {
  it.effect("has no rules before any is set", () =>
    withStore((store) =>
      Effect.gen(function* () {
        expect(yield* store.list).toEqual([]);
      }),
    ),
  );

  it.effect("adds a rule after the others, and replaces one in its place", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.set(sol);
        yield* store.set(luna);
        const changed = { model: sol.model, fallbacks: ["gpt-5.5"] };

        expect(yield* store.set(changed)).toEqual(changed);
        expect(yield* store.list).toEqual([changed, luna]);
      }),
    ),
  );

  it.effect("removes a rule, and fails on a model without one", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.set(sol);
        yield* store.set(luna);
        yield* store.remove(sol.model);

        expect(yield* store.list).toEqual([luna]);
        expect(yield* Effect.flip(store.remove(sol.model))).toEqual(
          new FallbackRuleNotFoundError({ model: sol.model }),
        );
      }),
    ),
  );

  it.effect("keeps the file readable only by the owner", () =>
    withStore((store, file) =>
      Effect.gen(function* () {
        yield* store.set(sol);

        expect((yield* (yield* FileSystem.FileSystem).stat(file)).mode & 0o777).toBe(0o600);
      }),
    ),
  );

  it.effect("reports a file it can't read as corrupt", () =>
    withStore((store, file) =>
      Effect.gen(function* () {
        yield* (yield* FileSystem.FileSystem).writeFileString(
          file,
          JSON.stringify([{ model: "a", fallbacks: ["a"] }]),
        );

        expect(yield* Effect.flip(store.list)).toBeInstanceOf(CorruptFileError);
      }),
    ),
  );

  it.effect("sees a rule another process set, without restarting", () =>
    withStore((serve, file) =>
      Effect.gen(function* () {
        expect(yield* serve.list).toEqual([]);

        yield* (yield* storeAt(file)).set(sol);

        expect(yield* serve.list).toEqual([sol]);
      }),
    ),
  );

  it.effect("signals each change it makes", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const signals = yield* Queue.unbounded<void>();
        yield* store.changes.pipe(
          Stream.runForEach(() => Queue.offer(signals, undefined)),
          Effect.forkChild,
        );
        // The signal `changes` gives at once, before any change.
        yield* Queue.take(signals);

        yield* store.set(sol);
        yield* Queue.take(signals);
        yield* store.remove(sol.model);
        yield* Queue.take(signals);
      }),
    ),
  );
});
