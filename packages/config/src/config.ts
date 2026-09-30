import { Effect, FileSystem, Schema } from "effect";

/**
 * An OpenAI-compatible provider. `baseUrl` may be left out for a provider via
 * knows, and the API key is read from the environment variable `apiKeyEnv`. A
 * provider without one, such as Ollama on your own machine, is sent no key.
 */
export const ProviderConfig = Schema.Struct({
  baseUrl: Schema.optionalKey(Schema.String),
  apiKeyEnv: Schema.optionalKey(Schema.String),
  sessionHeader: Schema.optionalKey(Schema.String),
});

export type ProviderConfig = typeof ProviderConfig.Type;

const UsdPerMillion = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** What a model costs, in USD per million tokens; cached input costs as much as input unless set. */
export const ModelPrice = Schema.Struct({
  input: UsdPerMillion,
  cachedInput: Schema.optionalKey(UsdPerMillion),
  output: UsdPerMillion,
});

export type ModelPrice = typeof ModelPrice.Type;

const Config = Schema.Struct({
  host: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("127.0.0.1"))),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(8317)),
  ),
  codex: Schema.Struct({
    cloak: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  providers: Schema.Record(Schema.String, ProviderConfig).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  /** Prices by model, over those via ships with. */
  prices: Schema.Record(Schema.String, ModelPrice).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});

export class InvalidConfigError extends Schema.TaggedError<InvalidConfigError>()(
  "InvalidConfigError",
  { path: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Invalid config in ${this.path}: ${this.reason}`;
  }
}

export const loadConfig = Effect.fn("loadConfig")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs.readFileString(path).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new InvalidConfigError({ path, reason: error.message })),
    ),
  );

  const raw = yield* Effect.try({
    try: () => Bun.YAML.parse(text) ?? {},
    catch: (cause) => new InvalidConfigError({ path, reason: String(cause) }),
  });

  return yield* Schema.decodeUnknownEffect(Config)(raw).pipe(
    Effect.mapError((error) => new InvalidConfigError({ path, reason: error.message })),
  );
});
