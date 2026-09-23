import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { InvalidConfigError, loadConfig } from "./index.ts";

const tempFile = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    return `${dir}/${name}`;
  });

layer(BunFileSystem.layer)("loadConfig", (it) => {
  it.effect("returns defaults when the file does not exist", () =>
    Effect.gen(function* () {
      const file = yield* tempFile("config.yaml");
      expect(yield* loadConfig(file)).toEqual({
        host: "127.0.0.1",
        port: 8317,
        codex: { cloak: true },
      });
    }),
  );

  it.effect("merges values from YAML over defaults", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "port: 9000\ncodex:\n  cloak: false\n");
      expect(yield* loadConfig(file)).toEqual({
        host: "127.0.0.1",
        port: 9000,
        codex: { cloak: false },
      });
    }),
  );

  it.effect("fails with InvalidConfigError naming the bad field", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "port: nope\n");
      const error = yield* Effect.flip(loadConfig(file));
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect(error.message).toMatch(/port/);
    }),
  );

  it.effect("fails with InvalidConfigError on malformed YAML", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "port: [unclosed\n");
      expect(yield* Effect.flip(loadConfig(file))).toBeInstanceOf(InvalidConfigError);
    }),
  );
});
