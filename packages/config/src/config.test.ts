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
        providers: {},
        prices: {},
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
        providers: {},
        prices: {},
      });
    }),
  );

  it.effect("reads OpenAI-compatible providers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(
        file,
        [
          "providers:",
          "  openrouter:",
          "    apiKeyEnv: OPENROUTER_API_KEY",
          "  local:",
          "    baseUrl: http://localhost:11434/v1",
          "    apiKeyEnv: LOCAL_KEY",
          "    sessionHeader: x-litellm-session-id",
          "",
        ].join("\n"),
      );
      expect((yield* loadConfig(file)).providers).toEqual({
        openrouter: { apiKeyEnv: "OPENROUTER_API_KEY" },
        local: {
          baseUrl: "http://localhost:11434/v1",
          apiKeyEnv: "LOCAL_KEY",
          sessionHeader: "x-litellm-session-id",
        },
      });
    }),
  );

  it.effect("reads model prices, in USD per million tokens", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(
        file,
        [
          "prices:",
          "  opencode-go/kimi-k3:",
          "    input: 0.6",
          "    cachedInput: 0.1",
          "    output: 2.5",
          "  local/llama:",
          "    input: 0",
          "    output: 0",
          "",
        ].join("\n"),
      );
      expect((yield* loadConfig(file)).prices).toEqual({
        "opencode-go/kimi-k3": { input: 0.6, cachedInput: 0.1, output: 2.5 },
        "local/llama": { input: 0, output: 0 },
      });
    }),
  );

  it.effect("rejects a negative price", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "prices:\n  m:\n    input: -1\n    output: 1\n");
      const error = yield* Effect.flip(loadConfig(file));
      expect(error).toBeInstanceOf(InvalidConfigError);
    }),
  );

  it.effect("rejects a provider without apiKeyEnv", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "providers:\n  openrouter: {}\n");
      const error = yield* Effect.flip(loadConfig(file));
      expect(error.message).toMatch(/apiKeyEnv/);
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

  it.effect("rejects a port outside 1-65535", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "port: 65536\n");
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

  it.effect(
    "fails with InvalidConfigError when the config file can't be read, instead of crashing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        // A directory where a file is expected: readFileString fails with a PlatformError
        // whose reason isn't NotFound, so loadConfig must not die on it.
        const error = yield* Effect.flip(loadConfig(dir));
        expect(error).toBeInstanceOf(InvalidConfigError);
        expect(error.path).toBe(dir);
      }),
  );
});
