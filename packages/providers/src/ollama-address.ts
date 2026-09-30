import { readJsonFile, withFileLock, writeJsonFile } from "@via/config";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

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
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // As the other stores do: this process's changes one at a time, and the file lock
    // against another process's.
    const permit = Semaphore.withPermit(yield* Semaphore.make(1));
    // Counts this process's changes, so `changes` can signal each one.
    const revision = yield* SubscriptionRef.make(0);

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit(
        withFileLock(path, effect).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      ).pipe(Effect.tap(() => SubscriptionRef.update(revision, (n) => n + 1)));

    const get = readJsonFile(path, Schema.NullOr(Stored), () => null).pipe(
      Effect.map((stored) => (stored === null ? Option.none() : Option.some(stored.address))),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.withSpan("OllamaAddress.get"),
    );

    const set = (address: string) =>
      serialized(
        writeJsonFile(path, Stored, { address }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      ).pipe(Effect.withSpan("OllamaAddress.set"));

    const remove = serialized(
      fs.remove(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
    ).pipe(Effect.withSpan("OllamaAddress.remove"));

    /** Signals now, then after every change this process makes to the address. */
    const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

    return { get, set, remove, changes };
  });

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
