import { Effect, FileSystem, Schema } from "effect";

/**
 * An OpenAI-compatible provider. `baseUrl` may be left out for a provider via
 * knows, and the API key is read from the environment variable `apiKeyEnv`.
 */
export const ProviderConfig = Schema.Struct({
  baseUrl: Schema.optionalKey(Schema.String),
  apiKeyEnv: Schema.String,
  sessionHeader: Schema.optionalKey(Schema.String),
});

export type ProviderConfig = typeof ProviderConfig.Type;

export const Config = Schema.Struct({
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
});

export type Config = typeof Config.Type;

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
    try: (): unknown => Bun.YAML.parse(text) ?? {},
    catch: (cause) => new InvalidConfigError({ path, reason: String(cause) }),
  });
  return yield* Schema.decodeUnknownEffect(Config)(raw).pipe(
    Effect.mapError((error) => new InvalidConfigError({ path, reason: error.message })),
  );
});
