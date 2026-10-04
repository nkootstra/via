/**
 * The admin API's reads as TanStack Query options, one factory per query and
 * the one place its key is written, and its calls for the screens' mutations.
 * Each goes through `run`, the one Effect boundary. Routes' loaders ensure the
 * data their page needs with these, and the page reads it with the same ones.
 */
import { infiniteQueryOptions, type QueryClient, queryOptions } from "@tanstack/react-query";
import { Effect, Option, Redacted } from "effect";
import { run } from "./client.ts";
import type { LoginStatus, RequestPage } from "./types.ts";

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

export type SignInOutcome = "signed-in" | "wrong-key" | "too-many" | "not-kept";

/**
 * Signs in with the admin key, then checks the session took: a browser that refuses
 * or shadows the cookie would otherwise bounce straight back to sign-in without a word.
 * A wrong key, the rate limit and a session not kept are outcomes, not failures.
 */
export const signIn = (key: string) =>
  run((admin) =>
    admin.session.signIn({ payload: { key: Redacted.make(key) } }).pipe(
      Effect.andThen(
        admin.session.get().pipe(
          Effect.as<SignInOutcome>("signed-in"),
          Effect.catchTag("Unauthorized", () => Effect.succeed<SignInOutcome>("not-kept")),
        ),
      ),
      Effect.catchTags({
        Unauthorized: () => Effect.succeed<SignInOutcome>("wrong-key"),
        TooManySignInsError: () => Effect.succeed<SignInOutcome>("too-many"),
      }),
    ),
  );

export const signOut = () => run((admin) => admin.session.signOut());

/**
 * How long what via sent, in the shell or over `/admin/events`, counts as fresh
 * without the stream: long enough for the page to open the stream first. While
 * the stream is open, it stays fresh (see `useLiveOptions`).
 */
const SENT_FRESH_MS = 10_000;

export const accountsQuery = queryOptions({
  queryKey: ["accounts"],
  queryFn: () => run((admin) => admin.accounts.list()),
  staleTime: SENT_FRESH_MS,
});

/**
 * The pool as it hands accounts out. via pushes its changes; without the stream,
 * it is asked for every 5 s, as cooldowns come and go.
 */
export const poolQuery = queryOptions({
  queryKey: ["pool"],
  queryFn: () => run((admin) => admin.pool.get()),
  staleTime: SENT_FRESH_MS,
  refetchInterval: 5_000,
});

/**
 * Rate limit windows, as via last fetched them in the background. via pushes
 * them; without the stream, asking is cheap: every 5 s, and every second while
 * via is fetching newer ones.
 */
export const usageQuery = queryOptions({
  queryKey: ["usage"],
  queryFn: () => run((admin) => admin.usage.get()),
  staleTime: SENT_FRESH_MS,
  refetchInterval: (query) => (query.state.data?.refreshing === true ? 1_000 : 5_000),
});

export const keysQuery = queryOptions({
  queryKey: ["keys"],
  queryFn: () => run((admin) => admin.keys.list()),
  staleTime: SENT_FRESH_MS,
});

export const modelsQuery = queryOptions({
  queryKey: ["models"],
  queryFn: () => run((admin) => admin.models.list()),
  staleTime: 60_000,
});

/** The fallback rules, and how each stands: via pushes it as accounts cool down and recover. */
export const fallbacksQuery = queryOptions({
  queryKey: ["fallbacks"],
  queryFn: () => run((admin) => admin.fallbacks.list()),
  staleTime: SENT_FRESH_MS,
});

/** What the usage history is grouped by. */
export type HistoryGroupBy = "model" | "account" | "key";

/** A span of the usage history: from `from` up to `to`, in epoch milliseconds. */
export interface HistoryRange {
  readonly from: number;
  readonly to: number;
}

/**
 * How often the usage page asks again while it's open, so requests show up as
 * they're served; via pushes no event for each one.
 */
const HISTORY_REFRESH_MS = 15_000;

/**
 * What narrows the usage page: one model, one account (or `provider:<name>`,
 * a provider's requests no account served), one key, and failed requests only.
 */
export interface HistoryFilters {
  readonly model?: string;
  readonly accountId?: string;
  readonly keyId?: string;
  readonly outcome?: "error";
}

/** Each group's tokens per hour or day, in the viewer's time zone. */
export const historySeriesQuery = (
  range: HistoryRange,
  bucket: "hour" | "day",
  tzOffsetMinutes: number,
  groupBy: HistoryGroupBy,
  filters: HistoryFilters,
) =>
  queryOptions({
    queryKey: ["history", "series", range, bucket, tzOffsetMinutes, groupBy, filters],
    queryFn: () =>
      run((admin) =>
        admin.history.series({ query: { ...range, bucket, tzOffsetMinutes, groupBy, ...filters } }),
      ),
    refetchInterval: HISTORY_REFRESH_MS,
  });

/** Each group's usage over the range, with the totals. */
export const historyBreakdownQuery = (
  range: HistoryRange,
  groupBy: HistoryGroupBy,
  filters: HistoryFilters,
) =>
  queryOptions({
    queryKey: ["history", "breakdown", range, groupBy, filters],
    queryFn: () =>
      run((admin) => admin.history.breakdown({ query: { ...range, groupBy, ...filters } })),
    refetchInterval: HISTORY_REFRESH_MS,
  });

/** Where a page of requests starts: after the last request of the page before. */
type RequestCursor = Option.Option.Value<RequestPage["next"]>;

/** The first page starts at the newest request: after none. */
const newest: Option.Option<RequestCursor> = Option.none();

/** The requests in the range, newest first, a page at a time. */
export const historyRequestsQuery = (range: HistoryRange, filter: HistoryFilters) =>
  infiniteQueryOptions({
    queryKey: ["history", "requests", range, filter],
    queryFn: ({ pageParam }) =>
      run((admin) =>
        admin.history.requests({
          query: {
            ...range,
            ...filter,
            ...(pageParam === undefined
              ? {}
              : { afterAt: pageParam.at, afterId: pageParam.requestId }),
          },
        }),
      ),
    initialPageParam: Option.getOrUndefined(newest),
    getNextPageParam: (page) => Option.getOrUndefined(page.next),
    // Refetching an infinite query fetches every page it holds again, one by one, so
    // the list keeps up only while it shows its first page; loaded further, it holds still.
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 0) > 1 ? false : HISTORY_REFRESH_MS,
  });

/** Deletes every request the usage history kept. */
export const clearHistory = () => run((admin) => admin.history.clear());

/** Fetches the usage page's queries again, after the history changed under them. */
export function refreshHistory(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["history"] });
}

/**
 * Fetches again everything a change to the pool's accounts shows up in: both
 * account lists, the pool, usage and the models the accounts serve. While via
 * pushes its state, the stream brings the change too; this covers it when not.
 */
export function refreshPool(queryClient: QueryClient) {
  for (const { queryKey } of [accountsQuery, opencodeGoQuery, poolQuery, usageQuery, modelsQuery]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

export const updateAccount = (
  id: string,
  payload: { readonly label?: string; readonly enabled?: boolean },
) => run((admin) => admin.accounts.update({ params: { id }, payload }));

export const removeAccount = (id: string) =>
  run((admin) => admin.accounts.remove({ params: { id } }));

export const startLogin = () => run((admin) => admin.accounts.login());

/**
 * Where a device-code login stands: asked every 2 s while it is pending, and
 * never kept. `onAnswer` hears each answer as it arrives, so the one that ends
 * the login is acted on there, not in an effect after a render. Any answer but
 * pending is final, so it never goes stale: nothing asks again, and hears it twice.
 */
export const loginStatusQuery = (
  id: string | undefined,
  onAnswer: (answer: LoginStatus) => void = () => {},
) =>
  queryOptions({
    queryKey: ["login", id],
    queryFn: () =>
      run((admin) =>
        admin.accounts
          .loginStatus({ params: { id: id ?? "" } })
          .pipe(Effect.tap((answer) => Effect.sync(() => onAnswer(answer)))),
      ),
    enabled: id !== undefined,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2_000 : false),
    staleTime: (query) => (query.state.data?.status === "pending" ? 0 : Infinity),
    refetchOnWindowFocus: false,
    gcTime: 0,
  });

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

/** Renames a client API key, resolving to why via refused the name, if it did. */
export const renameKey = (id: string, name: string) =>
  run((admin) =>
    admin.keys.rename({ params: { idOrName: id }, payload: { name } }).pipe(
      Effect.as(undefined),
      Effect.catchTag("DuplicateKeyNameError", (error) =>
        Effect.succeed(`A key named "${error.name}" already exists. Choose another name.`),
      ),
    ),
  );

export const revokeKey = (id: string) =>
  run((admin) => admin.keys.revoke({ params: { idOrName: id } }));

export const opencodeGoQuery = queryOptions({
  queryKey: ["opencode-go"],
  queryFn: () => run((admin) => admin.opencodeGo.list()),
  staleTime: SENT_FRESH_MS,
});

/** Where Ollama is, if via knows one: the address the web UI saved, or config.yaml's. */
export const ollamaQuery = queryOptions({
  queryKey: ["ollama"],
  queryFn: () => run((admin) => admin.ollama.get()),
  staleTime: SENT_FRESH_MS,
});

/** What via finds at Ollama's address: its version and models, or why it can't use it. */
export type OllamaFound =
  | { readonly reachable: true; readonly version: string; readonly models: ReadonlyArray<string> }
  | { readonly reachable: false; readonly reason: string };

/** How long what via found at Ollama's address is shown before it looks again. */
const OLLAMA_CHECK_FRESH_MS = 30_000;

/**
 * Checks Ollama's address with via, which asks Ollama itself: an address that
 * can't be reached is an answer the page shows, not a failure to retry.
 */
export const ollamaCheckQuery = (address: string) =>
  queryOptions({
    queryKey: ["ollama", "check", address],
    queryFn: () =>
      run((admin) =>
        admin.ollama.check({ payload: { address } }).pipe(
          Effect.map(({ version, models }): OllamaFound => ({ reachable: true, version, models })),
          Effect.catchTags({
            OllamaUnreachableError: (error) =>
              Effect.succeed<OllamaFound>({ reachable: false, reason: error.reason }),
            OllamaAddressInvalidError: (error) =>
              Effect.succeed<OllamaFound>({ reachable: false, reason: error.message }),
          }),
        ),
      ),
    staleTime: OLLAMA_CHECK_FRESH_MS,
    retry: false,
  });

/** Saves Ollama's address, resolving to why via refused it, if it did. */
export const saveOllama = (address: string) =>
  run((admin) =>
    admin.ollama.set({ payload: { address } }).pipe(
      Effect.as(undefined),
      Effect.catchTags({
        OllamaAddressInvalidError: (error) => Effect.succeed(error.message),
        OllamaNotEditableError: (error) => Effect.succeed(error.message),
      }),
    ),
  );

export const removeOllama = () => run((admin) => admin.ollama.remove());

/**
 * Fetches again what Ollama's address shows up in: the address, the pool's
 * providers and the models. While via pushes its state, the stream brings it too.
 */
export function refreshOllama(queryClient: QueryClient) {
  for (const { queryKey } of [ollamaQuery, poolQuery, modelsQuery]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/** OpenRouter's key, masked, and the models it enables, if via has one. */
export const openrouterQuery = queryOptions({
  queryKey: ["openrouter"],
  queryFn: () => run((admin) => admin.openrouter.get()),
  staleTime: SENT_FRESH_MS,
});

/** How long OpenRouter's list of models is kept: it changes over days, not minutes. */
const OPENROUTER_CATALOG_FRESH_MS = 10 * 60_000;

/** Every model OpenRouter lists, to pick which via offers. */
export const openrouterCatalogQuery = queryOptions({
  queryKey: ["openrouter", "catalog"],
  queryFn: () => run((admin) => admin.openrouter.catalog()),
  staleTime: OPENROUTER_CATALOG_FRESH_MS,
});

/** Saves an OpenRouter key, which via checks with OpenRouter first, resolving to why not. */
export const saveOpenrouterKey = (apiKey: string) =>
  run((admin) =>
    admin.openrouter.setKey({ payload: { apiKey: Redacted.make(apiKey) } }).pipe(
      Effect.as(undefined),
      Effect.catchTags({
        OpenrouterKeyRejectedError: (error) => Effect.succeed(error.message),
        OpenrouterUnavailableError: (error) => Effect.succeed(error.message),
        OpenrouterNotEditableError: (error) => Effect.succeed(error.message),
      }),
    ),
  );

/** Offers exactly `models` of OpenRouter's, by their ids. */
export const saveOpenrouterModels = (models: ReadonlyArray<string>) =>
  run((admin) => admin.openrouter.setModels({ payload: { models } }));

export const removeOpenrouter = () => run((admin) => admin.openrouter.remove());

/**
 * Fetches again what OpenRouter's key and models show up in: the key, the
 * pool's providers and the models. While via pushes its state, the stream brings it too.
 */
export function refreshOpenrouter(queryClient: QueryClient) {
  for (const { queryKey } of [openrouterQuery, poolQuery, modelsQuery]) {
    void queryClient.invalidateQueries({ queryKey, exact: true });
  }
}

export type AddOpencodeGoOutcome =
  | { readonly added: true; readonly label: string }
  | { readonly added: false; readonly problem: string };

const notAdded = (problem: string) =>
  Effect.succeed<AddOpencodeGoOutcome>({ added: false, problem });

/**
 * Adds an OpenCode Go API key, which via checks with OpenCode Go first. A key
 * OpenCode Go refuses, one via already has, or one it can't check are outcomes
 * the form shows.
 */
export const addOpencodeGo = (apiKey: string) =>
  run((admin) =>
    admin.opencodeGo.add({ payload: { apiKey: Redacted.make(apiKey) } }).pipe(
      Effect.map((account): AddOpencodeGoOutcome => ({ added: true, label: account.label })),
      Effect.catchTags({
        OpencodeGoKeyRejectedError: () =>
          notAdded("OpenCode Go refused this key. Check that you copied all of it."),
        DuplicateOpencodeGoKeyError: (error) =>
          notAdded(`That key is already in the pool, as ${error.label}.`),
        OpencodeGoUnavailableError: (error) => notAdded(error.message),
      }),
    ),
  );

export const updateOpencodeGo = (
  id: string,
  payload: { readonly label?: string; readonly enabled?: boolean },
) => run((admin) => admin.opencodeGo.update({ params: { id }, payload }));

export const removeOpencodeGo = (id: string) =>
  run((admin) => admin.opencodeGo.remove({ params: { id } }));
