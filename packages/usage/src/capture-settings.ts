import { cachedUntilChanged, ownedFiles } from "@via/config";
import { Context, Effect, Layer, Semaphore, Stream, SubscriptionRef } from "effect";
import { CaptureSettings } from "./entry.ts";

/** Until the setting is saved, nothing is kept. */
const OFF: CaptureSettings = { keepFailedPrompts: false };

const make = (path: string) =>
  Effect.gen(function* () {
    const files = yield* ownedFiles;
    // This process's changes one at a time, and the file lock against another process's.
    const permit = Semaphore.withPermit(yield* Semaphore.make(1));
    // Counts this process's writes to the file, so `changes` can signal each one.
    const revision = yield* SubscriptionRef.make(0);

    /**
     * The settings now. A failed request reads them, so they're read from the file only once
     * it changed, by this process or another.
     */
    const get = yield* cachedUntilChanged({
      stamp: files.stamp(path),
      revision: SubscriptionRef.get(revision),
      read: files.read(path, CaptureSettings, () => OFF),
    });

    const set = (settings: CaptureSettings) =>
      permit(files.locked(path, files.write(path, CaptureSettings, settings))).pipe(
        Effect.tap(() => SubscriptionRef.update(revision, (n) => n + 1)),
        Effect.withSpan("CaptureSettings.set"),
      );

    /** Signals now, then after every change this process makes to the settings. */
    const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

    return { get: get.pipe(Effect.withSpan("CaptureSettings.get")), set, changes };
  });

/**
 * Whether via keeps the prompts of failed requests, as the web UI sets it, in one
 * owner-only JSON file at `path`. Off until it is turned on.
 */
export class CaptureSettingsStore extends Context.Service<
  CaptureSettingsStore,
  Effect.Success<ReturnType<typeof make>>
>()("via/CaptureSettingsStore") {
  static readonly layer = (path: string) => Layer.effect(CaptureSettingsStore, make(path));
}
