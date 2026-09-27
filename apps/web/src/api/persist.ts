/**
 * Keeps the overview's queries in sessionStorage, so a reload paints the last
 * data at once and then revalidates it. Only a signed-in session is kept, and
 * clearing the cache (signing out, or any 401) clears what is kept.
 */
import type { QueryClient } from "@tanstack/react-query";
import { AdminAccount, Pool, Usage } from "@via/server/admin-api";
import { Effect, Option, Schema } from "effect";

const STORAGE_KEY = "via:queries";

/** Older than this, what is kept is dropped rather than shown. */
const MAX_AGE_MS = 10 * 60_000;

/** A query's data, and when it was fetched (epoch millis). */
const entry = <S extends Schema.Top>(data: S) =>
  Schema.optional(Schema.Struct({ data, updatedAt: Schema.Finite }));

const Kept = Schema.fromJsonString(
  Schema.Struct({
    savedAt: Schema.Finite,
    session: entry(Schema.Literal(true)),
    pool: entry(Pool),
    usage: entry(Usage),
    accounts: entry(Schema.Array(AdminAccount)),
  }),
);

type Kept = typeof Kept.Type;

/** The queries kept, by their key's one element. */
const kept = ["session", "pool", "usage", "accounts"] as const;

/** sessionStorage, when this browser lets the page use it. */
const storage = Effect.try(() => globalThis.sessionStorage).pipe(Effect.option);

/** What `queryClient` holds of the kept queries, encoded; none when it holds nothing. */
const snapshot = (queryClient: QueryClient, now: number) => {
  const value: Record<string, { data: unknown; updatedAt: number }> = {};

  for (const name of kept) {
    const state = queryClient.getQueryState([name]);

    if (state?.data !== undefined && (name !== "session" || state.data === true)) {
      value[name] = { data: state.data, updatedAt: state.dataUpdatedAt };
    }
  }

  return Object.keys(value).length === 0
    ? Option.none()
    : Schema.encodeUnknownOption(Kept)({ savedAt: now, ...value });
};

const save = (queryClient: QueryClient) =>
  Effect.gen(function* () {
    const store = yield* storage;

    if (Option.isNone(store)) return;
    const text = snapshot(queryClient, Date.now());

    yield* Effect.try(() =>
      Option.match(text, {
        onNone: () => store.value.removeItem(STORAGE_KEY),
        onSome: (json) => store.value.setItem(STORAGE_KEY, json),
      }),
    );
  }).pipe(Effect.ignore);

const restore = (queryClient: QueryClient) =>
  Effect.gen(function* () {
    const store = yield* storage;

    if (Option.isNone(store)) return;
    const text = yield* Effect.try(() => store.value.getItem(STORAGE_KEY));

    if (text === null) return;
    const value: Kept = yield* Schema.decodeEffect(Kept)(text);

    if (Date.now() - value.savedAt > MAX_AGE_MS) return;

    for (const name of kept) {
      const query = value[name];

      if (query !== undefined) {
        queryClient.setQueryData([name], query.data, { updatedAt: query.updatedAt });
      }
    }
  }).pipe(Effect.ignore);

/**
 * Fills `queryClient` with what the last page kept, then keeps it up to date
 * with every change to the kept queries, their removal included.
 */
export function persistQueries(queryClient: QueryClient) {
  Effect.runSync(restore(queryClient));

  queryClient.getQueryCache().subscribe((event) => {
    const [name] = event.query.queryKey;

    if (
      (event.type === "updated" || event.type === "removed") &&
      kept.some((key) => key === name)
    ) {
      Effect.runSync(save(queryClient));
    }
  });
}
