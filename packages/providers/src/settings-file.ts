import { ownedFiles } from "@via/config";
import { Effect, FileSystem, Option, Schema, Semaphore, Stream, SubscriptionRef } from "effect";

/**
 * One value of `schema`, kept in an owner-only JSON file at `path`, or none
 * while the file is missing: what the web UI saves for a provider.
 */
export const settingsFile = <S extends Schema.Codec<unknown, unknown>>(path: string, schema: S) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* ownedFiles;
    // As the other stores do: this process's changes one at a time, and the file lock
    // against another process's.
    const permit = Semaphore.withPermit(yield* Semaphore.make(1));
    // Counts this process's changes, so `changes` can signal each one.
    const revision = yield* SubscriptionRef.make(0);

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit(files.locked(path, effect)).pipe(
        Effect.tap(() => SubscriptionRef.update(revision, (n) => n + 1)),
      );

    const get = files
      .read(path, Schema.NullOr(schema), () => null)
      .pipe(
        Effect.map((stored): Option.Option<S["Type"]> =>
          stored === null ? Option.none() : Option.some(stored),
        ),
      );

    const set = (value: S["Type"]) => serialized(files.write(path, schema, value));

    const remove = serialized(
      fs.remove(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
    );

    /** Signals now, then after every change this process makes to the file. */
    const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

    return { get, set, remove, changes };
  });
