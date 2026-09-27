/**
 * The admin API's reads as TanStack Query options, and its calls for the
 * screens' mutations. Each goes through `run`, the one Effect boundary.
 */
import {
  type FetchQueryOptions,
  keepPreviousData,
  type QueryClient,
  type QueryKey,
  queryOptions,
} from "@tanstack/react-query";
import { Effect, Redacted } from "effect";
import { run } from "./client.ts";

/** Whether the browser has a session: true, or false on a 401. */
export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: () =>
    run((admin) =>
      admin.session.get().pipe(
        Effect.as(true),
        Effect.catchTag("Unauthorized", () => Effect.succeed(false)),
      ),
    ),
  staleTime: 30_000,
});

export type SignInOutcome = "signed-in" | "wrong-key" | "too-many";

/** Signs in with the admin key. A wrong key and the rate limit are outcomes, not failures. */
export const signIn = (key: string) =>
  run((admin) =>
    admin.session.signIn({ payload: { key: Redacted.make(key) } }).pipe(
      Effect.as<SignInOutcome>("signed-in"),
      Effect.catchTags({
        Unauthorized: () => Effect.succeed<SignInOutcome>("wrong-key"),
        TooManySignInsError: () => Effect.succeed<SignInOutcome>("too-many"),
      }),
    ),
  );

export const signOut = () => run((admin) => admin.session.signOut());

export const accountsQuery = queryOptions({
  queryKey: ["accounts"],
  queryFn: () => run((admin) => admin.accounts.list()),
});

/** The pool as it hands accounts out; cooldowns come and go, so it refreshes every 5 s. */
export const poolQuery = queryOptions({
  queryKey: ["pool"],
  queryFn: () => run((admin) => admin.pool.get()),
  refetchInterval: 5_000,
  placeholderData: keepPreviousData,
});

/**
 * Rate limit windows, as via last fetched them in the background, so asking is
 * cheap: every 5 s, and every second while via is fetching newer ones.
 */
export const usageQuery = queryOptions({
  queryKey: ["usage"],
  queryFn: () => run((admin) => admin.usage.get()),
  refetchInterval: (query) => (query.state.data?.refreshing === true ? 1_000 : 5_000),
  placeholderData: keepPreviousData,
});

export const keysQuery = queryOptions({
  queryKey: ["keys"],
  queryFn: () => run((admin) => admin.keys.list()),
});

export const modelsQuery = queryOptions({
  queryKey: ["models"],
  queryFn: () => run((admin) => admin.models.list()),
  staleTime: 60_000,
});

/**
 * Starts fetching `query` when it has no data yet, without waiting: a route's
 * loader, run when the viewer points at its link, so the page opens on data.
 */
export function warm<Data, Key extends QueryKey>(
  queryClient: QueryClient,
  query: FetchQueryOptions<Data, Error, Data, Key> & { readonly queryKey: Key },
) {
  if (queryClient.getQueryData(query.queryKey) === undefined) void queryClient.prefetchQuery(query);
}

export const updateAccount = (
  id: string,
  payload: { readonly label?: string; readonly enabled?: boolean },
) => run((admin) => admin.accounts.update({ params: { id }, payload }));

export const removeAccount = (id: string) =>
  run((admin) => admin.accounts.remove({ params: { id } }));

export const startLogin = () => run((admin) => admin.accounts.login());

export const loginStatus = (id: string) =>
  run((admin) => admin.accounts.loginStatus({ params: { id } }));

export type CreateKeyOutcome =
  | { readonly created: true; readonly name: string; readonly key: string }
  | { readonly created: false; readonly duplicate: string };

/** Creates a client API key; a taken name is an outcome the form shows. */
export const createKey = (name: string) =>
  run((admin) =>
    admin.keys.create({ payload: { name } }).pipe(
      Effect.map((key): CreateKeyOutcome => ({ created: true, name: key.name, key: key.key })),
      Effect.catchTag("DuplicateKeyNameError", (error) =>
        Effect.succeed<CreateKeyOutcome>({ created: false, duplicate: error.name }),
      ),
    ),
  );

export const revokeKey = (id: string) =>
  run((admin) => admin.keys.revoke({ params: { idOrName: id } }));
