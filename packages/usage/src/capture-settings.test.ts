import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import { CaptureSettingsStore } from "./capture-settings.ts";

/** Settings over a file in a fresh directory, as another process would open them. */
const settingsAt = (file: string) =>
  Effect.map(Layer.build(CaptureSettingsStore.layer(file)), (context) =>
    Context.get(context, CaptureSettingsStore),
  );

const tempFile = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  Effect.map(fs.makeTempDirectoryScoped(), (dir) => `${dir}/capture.json`),
);

layer(BunFileSystem.layer)("CaptureSettingsStore", (it) => {
  it.effect("keeps no prompts until told to", () =>
    Effect.gen(function* () {
      const settings = yield* settingsAt(yield* tempFile);

      expect(yield* settings.get).toEqual({ keepFailedPrompts: false });
    }),
  );

  it.effect("keeps what it is set to, owner-only, for another process to read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* tempFile;
      const settings = yield* settingsAt(file);

      yield* settings.set({ keepFailedPrompts: true });

      expect(yield* settings.get).toEqual({ keepFailedPrompts: true });
      expect(yield* (yield* settingsAt(file)).get).toEqual({ keepFailedPrompts: true });
      expect(((yield* fs.stat(file)).mode & 0o777).toString(8)).toBe("600");

      yield* settings.set({ keepFailedPrompts: false });

      expect(yield* settings.get).toEqual({ keepFailedPrompts: false });
    }),
  );

  it.effect("sees a change another process made", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const settings = yield* settingsAt(file);
      expect(yield* settings.get).toEqual({ keepFailedPrompts: false });

      yield* (yield* settingsAt(file)).set({ keepFailedPrompts: true });

      expect(yield* settings.get).toEqual({ keepFailedPrompts: true });
    }),
  );

  it.effect("signals at once, then after each change", () =>
    Effect.gen(function* () {
      const settings = yield* settingsAt(yield* tempFile);

      const seen = yield* settings.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* settings.set({ keepFailedPrompts: true });

      expect(yield* Fiber.join(seen)).toHaveLength(2);
    }),
  );
});
