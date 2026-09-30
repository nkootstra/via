import { Context, Effect, Layer, Schema } from "effect";
import { settingsFile } from "./settings-file.ts";

/** An OpenRouter key saved in the web UI, and the models via offers of it. */
const Stored = Schema.Struct({
  apiKey: Schema.RedactedFromValue(Schema.String),
  models: Schema.Array(Schema.String),
});

export type OpenrouterSaved = typeof Stored.Type;

/**
 * The OpenRouter key added in the web UI, rather than in config.yaml, and the
 * models it enables, in one owner-only JSON file at `path`.
 */
export class OpenrouterSettings extends Context.Service<
  OpenrouterSettings,
  Effect.Success<ReturnType<typeof settingsFile<typeof Stored>>>
>()("via/OpenrouterSettings") {
  static readonly layer = (path: string) =>
    Layer.effect(OpenrouterSettings, settingsFile(path, Stored));
}
