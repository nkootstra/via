import { Context, Effect, Layer, Option, Schema } from "effect";
import { settingsFile } from "./settings-file.ts";

const Stored = Schema.Struct({ address: Schema.String });

/**
 * Ollama's address as via keeps it, from one typed in: `http://` when it names
 * no scheme, and without a trailing `/` or the `/v1` via adds itself. None for
 * what isn't an http or https address.
 */
export const parseOllamaAddress = (input: string): Option.Option<string> => {
  const trimmed = input.trim();
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;

  if (trimmed === "" || !URL.canParse(withScheme)) return Option.none();
  const url = new URL(withScheme);

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") {
    return Option.none();
  }

  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");

  return Option.some(`${url.protocol}//${url.host}${path}`);
};

const make = (path: string) =>
  Effect.map(settingsFile(path, Stored), (file) => ({
    get: Effect.map(
      file.get,
      Option.map(({ address }) => address),
    ).pipe(Effect.withSpan("OllamaAddress.get")),
    set: (address: string) => file.set({ address }).pipe(Effect.withSpan("OllamaAddress.set")),
    remove: file.remove.pipe(Effect.withSpan("OllamaAddress.remove")),
    changes: file.changes,
  }));

/**
 * The address of the Ollama added in the web UI, rather than in config.yaml,
 * in one owner-only JSON file at `path`.
 */
export class OllamaAddress extends Context.Service<
  OllamaAddress,
  Effect.Success<ReturnType<typeof make>>
>()("via/OllamaAddress") {
  static readonly layer = (path: string) => Layer.effect(OllamaAddress, make(path));
}
