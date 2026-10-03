import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { startFakeProvider } from "@via/providers/testing";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { createKey, freePort, runVia, serveVia, tempHome, writeConfig } from "./helpers.ts";

/** A home whose config.yaml sends OpenRouter and Ollama to fakes of them. */
const setup = Effect.gen(function* () {
  const openrouter = yield* startFakeProvider;
  const home = yield* tempHome;
  yield* writeConfig(home, `providers:\n  openrouter:\n    baseUrl: ${openrouter.url}\n`);

  const via = (args: ReadonlyArray<string>, input?: string) => runVia(home, args, {}, input);

  return { home, openrouter, via };
});

const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** The ids of the models `via serve` offers in `home`. */
const servedModels = (home: string) =>
  Effect.gen(function* () {
    const key = yield* createKey(home, "test");
    const url = yield* serveVia(home, ["--port", "0"]);
    const client = yield* HttpClient.HttpClient;

    const response = yield* client.execute(
      HttpClientRequest.get(`${url}/v1/models`).pipe(HttpClientRequest.bearerToken(key)),
    );

    const { data } = yield* Schema.decodeUnknownEffect(Models)(yield* response.json);

    return data.map(({ id }) => id);
  });

layer(Layer.mergeAll(BunFileSystem.layer, FetchHttpClient.layer))("via providers", (it) => {
  it.effect("openrouter set-key keeps a key OpenRouter takes, read from stdin", () =>
    Effect.gen(function* () {
      const { openrouter, via } = yield* setup;
      openrouter.openrouterKey("sk-or-good", { limit: null });

      const saved = yield* via(["providers", "openrouter", "set-key"], "sk-or-good\n");
      expect(saved.stderr).toBe("");
      expect(saved.exitCode).toBe(0);
      expect(saved.stdout).toBe("Saved OpenRouter key …good. Restart `via serve` to use it.\n");
      expect((yield* via(["accounts", "status"])).stdout).toMatch(
        /^openrouter {2}provider {2}available$/m,
      );
    }),
  );

  it.effect("openrouter set-key does not keep a key OpenRouter refuses", () =>
    Effect.gen(function* () {
      const { via } = yield* setup;
      const saved = yield* via(["providers", "openrouter", "set-key"], "sk-or-bad");
      expect(saved.exitCode).toBe(1);
      expect(saved.stderr).toBe(
        "error: OpenRouter refused this API key (HTTP 401); check that it is right\n",
      );
      expect((yield* via(["accounts", "status"])).stdout).not.toContain("openrouter");
    }),
  );

  it.effect("openrouter set-key refuses an empty key", () =>
    Effect.gen(function* () {
      const { via } = yield* setup;
      const saved = yield* via(["providers", "openrouter", "set-key"], "");
      expect(saved.exitCode).toBe(1);
      expect(saved.stderr).toBe("error: No OpenRouter API key was given\n");
    }),
  );

  it.effect("openrouter set-key leaves a key config.yaml names alone", () =>
    Effect.gen(function* () {
      const { home, openrouter } = yield* setup;
      openrouter.openrouterKey("sk-or-good", { limit: null });
      yield* writeConfig(
        home,
        `providers:\n  openrouter:\n    baseUrl: ${openrouter.url}\n    apiKeyEnv: OR_KEY\n`,
      );

      const saved = yield* runVia(
        home,
        ["providers", "openrouter", "set-key"],
        { OR_KEY: "sk-or-good" },
        "sk-or-good",
      );

      expect(saved.exitCode).toBe(1);
      expect(saved.stderr).toBe("error: OpenRouter is set up in config.yaml: change it there\n");
    }),
  );

  it.effect("openrouter models chooses the models via serve offers", () =>
    Effect.gen(function* () {
      const { home, openrouter, via } = yield* setup;
      openrouter.openrouterKey("sk-or-good", { limit: null });
      openrouter.models(["openai/gpt-6", "anthropic/claude-5", "google/gemini-4"]);
      yield* via(["providers", "openrouter", "set-key"], "sk-or-good");

      const chosen = yield* via([
        "providers",
        "openrouter",
        "models",
        "openai/gpt-6",
        "google/gemini-4",
      ]);

      expect(chosen.exitCode).toBe(0);
      expect(chosen.stdout).toBe(
        "via offers 2 OpenRouter models: openai/gpt-6, google/gemini-4. Restart `via serve` to use them.\n",
      );
      expect(yield* servedModels(home)).toEqual([
        "openrouter/openai/gpt-6",
        "openrouter/google/gemini-4",
      ]);
    }),
  );

  it.effect("openrouter models with none given offers none", () =>
    Effect.gen(function* () {
      const { openrouter, via } = yield* setup;
      openrouter.openrouterKey("sk-or-good", { limit: null });
      yield* via(["providers", "openrouter", "set-key"], "sk-or-good");
      const chosen = yield* via(["providers", "openrouter", "models"]);
      expect(chosen.exitCode).toBe(0);
      expect(chosen.stdout).toBe(
        "via offers no OpenRouter models. Restart `via serve` to use them.\n",
      );
    }),
  );

  it.effect("openrouter models needs a key first", () =>
    Effect.gen(function* () {
      const { via } = yield* setup;
      const chosen = yield* via(["providers", "openrouter", "models", "openai/gpt-6"]);
      expect(chosen.exitCode).toBe(1);
      expect(chosen.stderr).toBe("error: Add an OpenRouter key first\n");
    }),
  );

  it.effect("openrouter remove forgets the key", () =>
    Effect.gen(function* () {
      const { openrouter, via } = yield* setup;
      openrouter.openrouterKey("sk-or-good", { limit: null });
      yield* via(["providers", "openrouter", "set-key"], "sk-or-good");
      const removed = yield* via(["providers", "openrouter", "remove"]);
      expect(removed.exitCode).toBe(0);
      expect(removed.stdout).toBe("Removed OpenRouter. Restart `via serve` to stop using it.\n");
      expect((yield* via(["accounts", "status"])).stdout).not.toContain("openrouter");
    }),
  );

  it.effect("ollama set keeps Ollama's address, and says what answers there", () =>
    Effect.gen(function* () {
      const { via } = yield* setup;
      const ollama = yield* startFakeProvider;
      ollama.ollama("0.12.0");
      ollama.models(["nimble", "swift"]);

      const saved = yield* via(["providers", "ollama", "set", `${ollama.url}/v1/`]);
      expect(saved.exitCode).toBe(0);
      expect(saved.stdout).toBe(
        `Saved Ollama at ${ollama.url}: Ollama 0.12.0, with nimble, swift. Restart \`via serve\` to use it.\n`,
      );
      expect((yield* via(["accounts", "status"])).stdout).toMatch(
        /^ollama {2}provider {2}available$/m,
      );
    }),
  );

  it.effect("ollama set keeps an address nothing answers at, and says so", () =>
    Effect.gen(function* () {
      const { via } = yield* setup;
      const address = `http://127.0.0.1:${yield* freePort}`;
      const saved = yield* via(["providers", "ollama", "set", address]);
      expect(saved.exitCode).toBe(0);
      expect(saved.stdout).toBe(
        `Saved Ollama at ${address}, but could not reach it: nothing answered there. Restart \`via serve\` to use it.\n`,
      );
    }),
  );

  it.effect("ollama set refuses what isn't an address", () =>
    Effect.gen(function* () {
      const { via } = yield* setup;
      const saved = yield* via(["providers", "ollama", "set", "ftp://nas"]);
      expect(saved.exitCode).toBe(1);
      expect(saved.stderr).toBe(
        `error: "ftp://nas" isn't an address: give Ollama's, such as http://192.168.1.20:11434\n`,
      );
    }),
  );

  it.effect("ollama remove forgets the address", () =>
    Effect.gen(function* () {
      const { via } = yield* setup;
      const ollama = yield* startFakeProvider;
      ollama.ollama("0.12.0");
      yield* via(["providers", "ollama", "set", ollama.url]);
      const removed = yield* via(["providers", "ollama", "remove"]);
      expect(removed.exitCode).toBe(0);
      expect(removed.stdout).toBe("Removed Ollama. Restart `via serve` to stop using it.\n");
      expect((yield* via(["accounts", "status"])).stdout).not.toContain("ollama");
    }),
  );

  it.effect("ollama set leaves an Ollama config.yaml sets up alone", () =>
    Effect.gen(function* () {
      const { home, via } = yield* setup;
      yield* writeConfig(home, "providers:\n  ollama: {}\n");
      const saved = yield* via(["providers", "ollama", "set", "http://nas:11434"]);
      expect(saved.exitCode).toBe(1);
      expect(saved.stderr).toBe(
        "error: Ollama is set up in config.yaml: change its address there\n",
      );
    }),
  );
});
