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
          "    cacheWrite: 0.75",
          "    output: 2.5",
          "  local/llama:",
          "    input: 0",
          "    output: 0",
          "",
        ].join("\n"),
      );
      expect((yield* loadConfig(file)).prices).toEqual({
        "opencode-go/kimi-k3": { input: 0.6, cachedInput: 0.1, cacheWrite: 0.75, output: 2.5 },
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

  it.effect("reads a provider without apiKeyEnv, as one on your own machine needs no key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "providers:\n  ollama:\n    baseUrl: http://nas:11434/v1\n");
      expect((yield* loadConfig(file)).providers).toEqual({
        ollama: { baseUrl: "http://nas:11434/v1" },
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

  it.effect("rejects an unknown top-level key, naming it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "prot: 9000\n");
      const error = yield* Effect.flip(loadConfig(file));
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect(error.message).toMatch(/prot/);
    }),
  );

  it.effect("rejects an unknown key in a provider, naming it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile("config.yaml");
      yield* fs.writeFileString(file, "providers:\n  openrouter:\n    apiKeyENV: KEY\n");
      const error = yield* Effect.flip(loadConfig(file));
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect(error.message).toMatch(/apiKeyENV/);
    }),
  );

  it.effect("rejects an unknown key under codex or in a price", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const codex = yield* tempFile("codex.yaml");
      yield* fs.writeFileString(codex, "codex:\n  cloack: false\n");
      expect((yield* Effect.flip(loadConfig(codex))).message).toMatch(/cloack/);
      const price = yield* tempFile("price.yaml");
      yield* fs.writeFileString(
        price,
        "prices:\n  m:\n    input: 1\n    output: 1\n    cached: 1\n",
      );
      expect((yield* Effect.flip(loadConfig(price))).message).toMatch(/cached/);
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
