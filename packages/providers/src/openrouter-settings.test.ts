import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Option, Redacted, type Scope } from "effect";
import { OpenrouterSettings } from "./index.ts";

const withStore = <A, E>(
  body: (
    file: string,
  ) => Effect.Effect<A, E, OpenrouterSettings | FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${yield* fs.makeTempDirectoryScoped()}/openrouter.json`;

    return yield* body(file).pipe(Effect.provide(OpenrouterSettings.layer(file)));
  });

layer(BunFileSystem.layer)("OpenrouterSettings", (it) => {
  it.effect("keeps a key and the models it enables, in a file only its owner can read", () =>
    withStore((file) =>
      Effect.gen(function* () {
        const store = yield* OpenrouterSettings;
        expect(yield* store.get).toEqual(Option.none());

        yield* store.set({ apiKey: Redacted.make("sk-or-1234"), models: ["openai/gpt-6"] });
        const fs = yield* FileSystem.FileSystem;
        const saved = yield* store.get;

        expect(Option.map(saved, ({ apiKey }) => Redacted.value(apiKey))).toEqual(
          Option.some("sk-or-1234"),
        );
        expect(Option.map(saved, ({ models }) => models)).toEqual(Option.some(["openai/gpt-6"]));
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
          apiKey: "sk-or-1234",
          models: ["openai/gpt-6"],
        });
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);

        yield* store.remove;
        expect(yield* store.get).toEqual(Option.none());
      }),
    ),
  );
});
