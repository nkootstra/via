import { Cache, Context, Effect, Layer, type Option } from "effect";

// Codex's prompt cache does not outlive an hour of inactivity, so there is
// nothing to gain from remembering a session any longer than that. Every
// successful dispatch rebinds its session, which refreshes this TTL, so an
// active conversation is kept alive for as long as it keeps being used.
const IDLE_TTL = "1 hour";

// Bounds memory use; oldest entries are evicted once the pool has this many
// sessions bound at once.
const CAPACITY = 10_000;

/** Which account last served each session, so its Codex requests stay on a warm cache. */
export class SessionBindings extends Context.Service<
  SessionBindings,
  {
    /** The account that last answered `session`, if via still remembers it. */
    readonly get: (session: string) => Effect.Effect<Option.Option<string>>;
    /** Remembers that `accountId` answered `session`, so it is preferred next time. */
    readonly bind: (session: string, accountId: string) => Effect.Effect<void>;
  }
>()("via/SessionBindings") {
  /** Kept in memory only: a restart loses nothing a warm prompt cache needed anyway. */
  static readonly layer = Layer.effect(
    SessionBindings,
    Effect.gen(function* () {
      const cache = yield* Cache.make<string, string>({
        capacity: CAPACITY,
        // Never invoked: a binding only ever comes from `bind`, so a miss has nothing to look up.
        lookup: () => Effect.die(new Error("SessionBindings: no binding to look up for a miss")),
        timeToLive: IDLE_TTL,
      });

      return SessionBindings.of({
        get: (session) => Cache.getSuccess(cache, session),
        bind: (session, accountId) => Cache.set(cache, session, accountId),
      });
    }),
  );
}
