import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Option, Ref, type Scope, Stream } from "effect";
import { OllamaAddress, parseOllamaAddress } from "./index.ts";

const withStore = <A, E>(
  body: (file: string) => Effect.Effect<A, E, OllamaAddress | FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${yield* fs.makeTempDirectoryScoped()}/ollama.json`;

    return yield* body(file).pipe(Effect.provide(OllamaAddress.layer(file)));
  });

layer(BunFileSystem.layer)("OllamaAddress", (it) => {
  it.effect("has no address until one is saved", () =>
    withStore(() =>
      Effect.gen(function* () {
        expect(yield* (yield* OllamaAddress).get).toEqual(Option.none());
      }),
    ),
  );

  it.effect("keeps a saved address in a file only its owner can read", () =>
    withStore((file) =>
      Effect.gen(function* () {
        yield* (yield* OllamaAddress).set("http://192.168.1.20:11434");
        const fs = yield* FileSystem.FileSystem;

        expect(yield* (yield* OllamaAddress).get).toEqual(Option.some("http://192.168.1.20:11434"));
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
          address: "http://192.168.1.20:11434",
        });
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
      }),
    ),
  );

  it.effect("forgets the address once it is removed, and removing none is fine", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* OllamaAddress;
        yield* store.set("http://localhost:11434");
        yield* store.remove;
        yield* store.remove;

        expect(yield* store.get).toEqual(Option.none());
      }),
    ),
  );

  it.effect("signals each change", () =>
    withStore(() =>
      Effect.gen(function* () {
        const store = yield* OllamaAddress;
        const seen = yield* Ref.make(0);
        yield* store.changes.pipe(
          Stream.runForEach(() => Ref.update(seen, (n) => n + 1)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        yield* store.set("http://localhost:11434");
        yield* store.remove;
        yield* Effect.yieldNow;

        expect(yield* Ref.get(seen)).toBe(3);
      }),
    ),
  );
});

layer(BunFileSystem.layer)("parseOllamaAddress", (it) => {
  it("takes Ollama's address as its app shows it, or with its /v1 path", () => {
    expect(parseOllamaAddress("http://192.168.1.20:11434")).toEqual(
      Option.some("http://192.168.1.20:11434"),
    );
    expect(parseOllamaAddress(" http://nas:11434/v1/ ")).toEqual(Option.some("http://nas:11434"));
    expect(parseOllamaAddress("https://ollama.example.com/")).toEqual(
      Option.some("https://ollama.example.com"),
    );
  });

  it("assumes http for an address given without one", () => {
    expect(parseOllamaAddress("localhost:11434")).toEqual(Option.some("http://localhost:11434"));
  });

  it("refuses what isn't an http address", () => {
    expect(parseOllamaAddress("")).toEqual(Option.none());
    expect(parseOllamaAddress("ftp://nas:11434")).toEqual(Option.none());
    expect(parseOllamaAddress("http://")).toEqual(Option.none());
  });
});
