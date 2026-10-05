import {
  cachedUntilChanged,
  fileStamp,
  readJsonFile,
  withFileLock,
  writeJsonFile,
} from "@via/config";
import { Context, Effect, FileSystem, Layer, Semaphore, Stream, SubscriptionRef } from "effect";
import { type FallbackRule, FallbackRuleNotFoundError, FallbackRules } from "./rule.ts";

const make = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // set and remove read the file, then write it whole: run them one at a time, or concurrent
    // changes overwrite each other. The semaphore orders this process's changes; the file lock
    // orders them against another process's (`via fallbacks` next to `via serve`).
    const permit = Semaphore.withPermit(yield* Semaphore.make(1));
    // Counts this process's writes to the file, so `changes` can signal each one.
    const revision = yield* SubscriptionRef.make(0);

    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      permit(
        withFileLock(path, effect).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      ).pipe(Effect.tap(() => SubscriptionRef.update(revision, (n) => n + 1)));

    const read = readJsonFile(path, FallbackRules, () => []).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );

    const write = (rules: ReadonlyArray<FallbackRule>) =>
      writeJsonFile(path, FallbackRules, rules).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

    /**
     * Every rule, in the order they were added. A request reads them when its model can't
     * serve, so they're read from the file only once it changed, by this process or another
     * (`via fallbacks set`, so the next request sees it).
     */
    const list = yield* cachedUntilChanged({
      stamp: fileStamp(path).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      revision: SubscriptionRef.get(revision),
      read,
    });

    /** Sets `rule`, in place of the model's rule if it has one, else after the others. */
    const set = Effect.fn("FallbackRuleStore.set")(function* (rule: FallbackRule) {
      const rules = yield* read;

      yield* write(
        rules.some((known) => known.model === rule.model)
          ? rules.map((known) => (known.model === rule.model ? rule : known))
          : [...rules, rule],
      );

      return rule;
    }, serialized);

    const remove = Effect.fn("FallbackRuleStore.remove")(function* (model: string) {
      const rules = yield* read;

      if (!rules.some((rule) => rule.model === model)) {
        return yield* new FallbackRuleNotFoundError({ model });
      }

      yield* write(rules.filter((rule) => rule.model !== model));
    }, serialized);

    /** Signals now, then after every change this process makes to the rules. */
    const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

    return { list, set, remove, changes };
  });

/** The models via falls back to when one can't serve, kept in their own file. */
export class FallbackRuleStore extends Context.Service<
  FallbackRuleStore,
  Effect.Success<ReturnType<typeof make>>
>()("via/FallbackRuleStore") {
  static readonly layer = (path: string) => Layer.effect(FallbackRuleStore, make(path));
}
