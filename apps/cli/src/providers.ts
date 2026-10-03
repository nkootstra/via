import { loadConfig } from "@via/config";
import { maskKey, parseOllamaAddress, Providers } from "@via/providers";
import { OllamaAddressInvalidError, OpenrouterNotEditableError } from "@via/providers/errors";
import { Console, Effect, Record } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { apiKeys } from "./api-keys.ts";
import { readApiKey } from "./read-key.ts";
import { version } from "./version.ts";

/** `via serve` sets its providers up as it starts, so a change here waits for a restart. */
const restart = (what: string) => `Restart \`via serve\` to ${what}.`;

/**
 * Runs `effect` with Providers as config.yaml sets up provider `name`, and only
 * it: another provider's config can't stop this one being changed.
 */
const withProvider =
  (configPath: string, name: "openrouter" | "ollama") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const config = yield* loadConfig(configPath);
      const providers = Record.filter(config.providers, (_, key) => key === name);

      return yield* effect.pipe(
        Effect.provide(Providers.layer({ providers, apiKeys: yield* apiKeys(providers), version })),
      );
    }).pipe(
      // OpenRouter's key is config.yaml's then, whether or not its variable is set.
      Effect.catchTag("MissingApiKeyError", () => Effect.fail(new OpenrouterNotEditableError())),
    );

const setKey = (configPath: string) =>
  Command.make("set-key", {}, () =>
    Effect.gen(function* () {
      const apiKey = yield* readApiKey("OpenRouter");
      yield* Effect.flatMap(Providers, ({ openrouter }) => openrouter.setKey(apiKey));
      yield* Console.log(`Saved OpenRouter key ${maskKey(apiKey)}. ${restart("use it")}`);
    }).pipe(withProvider(configPath, "openrouter")),
  ).pipe(
    Command.withDescription(
      "Add or replace the OpenRouter API key, read from stdin or a prompt, once OpenRouter takes it",
    ),
  );

const models = (configPath: string) =>
  Command.make(
    "models",
    {
      models: Argument.String("model").pipe(
        Argument.withDescription("An OpenRouter model id, such as openai/gpt-5"),
        Argument.variadic(),
      ),
    },
    ({ models: chosen }) =>
      Effect.gen(function* () {
        yield* Effect.flatMap(Providers, ({ openrouter }) => openrouter.setModels(chosen));

        const offered =
          chosen.length === 0
            ? "no OpenRouter models"
            : `${chosen.length} OpenRouter models: ${chosen.join(", ")}`;

        yield* Console.log(`via offers ${offered}. ${restart("use them")}`);
      }).pipe(withProvider(configPath, "openrouter")),
  ).pipe(Command.withDescription("Choose the OpenRouter models via offers: exactly those given"));

const removeOpenrouter = (configPath: string) =>
  Command.make("remove", {}, () =>
    Effect.gen(function* () {
      yield* Effect.flatMap(Providers, ({ openrouter }) => openrouter.remove);
      yield* Console.log(`Removed OpenRouter. ${restart("stop using it")}`);
    }).pipe(withProvider(configPath, "openrouter")),
  ).pipe(Command.withDescription("Forget the OpenRouter key and models"));

const openrouter = (configPath: string) =>
  Command.make("openrouter").pipe(
    Command.withDescription("Set up OpenRouter, as the web UI does"),
    Command.withSubcommands([setKey(configPath), models(configPath), removeOpenrouter(configPath)]),
  );

/** What answers at Ollama's address, as the web UI shows it. */
const found = ({
  version: at,
  models: pulled,
}: {
  version: string;
  models: ReadonlyArray<string>;
}) =>
  `Ollama ${at}, ${pulled.length === 0 ? "with no models yet: pull one with ollama pull" : `with ${pulled.join(", ")}`}`;

const setOllama = (configPath: string) =>
  Command.make(
    "set",
    {
      address: Argument.String("address").pipe(
        Argument.withDescription("Where Ollama listens, such as http://192.168.1.20:11434"),
      ),
    },
    ({ address: given }) =>
      Effect.gen(function* () {
        const address = yield* Effect.fromOption(parseOllamaAddress(given)).pipe(
          Effect.mapError(() => new OllamaAddressInvalidError({ address: given })),
        );

        const { ollama } = yield* Providers;
        yield* ollama.set(address);
        // Kept like the web UI keeps it, reachable or not: Ollama may just not be running yet.

        const there = yield* ollama.check(address).pipe(
          Effect.map((answer) => `: ${found(answer)}`),
          Effect.catchTag("OllamaUnreachableError", ({ reason }) =>
            Effect.succeed(`, but could not reach it: ${reason}`),
          ),
        );

        yield* Console.log(`Saved Ollama at ${address}${there}. ${restart("use it")}`);
      }).pipe(withProvider(configPath, "ollama")),
  ).pipe(Command.withDescription("Add Ollama, or change its address"));

const removeOllama = (configPath: string) =>
  Command.make("remove", {}, () =>
    Effect.gen(function* () {
      yield* Effect.flatMap(Providers, ({ ollama }) => ollama.remove);
      yield* Console.log(`Removed Ollama. ${restart("stop using it")}`);
    }).pipe(withProvider(configPath, "ollama")),
  ).pipe(Command.withDescription("Forget Ollama's address"));

const ollama = (configPath: string) =>
  Command.make("ollama").pipe(
    Command.withDescription("Set up Ollama, as the web UI does"),
    Command.withSubcommands([setOllama(configPath), removeOllama(configPath)]),
  );

/** `via providers`: OpenRouter and Ollama, as the web UI sets them up, unless config.yaml does. */
export const providers = (configPath: string) =>
  Command.make("providers").pipe(
    Command.withDescription("Set up OpenRouter and Ollama, unless config.yaml does"),
    Command.withSubcommands([openrouter(configPath), ollama(configPath)]),
  );
