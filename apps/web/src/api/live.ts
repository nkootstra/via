/**
 * Keeps the page's admin state live from `/admin/events`: each `state` event
 * via pushes goes straight into the query cache, rather than invalidating the
 * queries and fetching them again. While the stream is open, nothing needs
 * polling; while it's down, the queries poll as they would without it, until
 * the browser's EventSource reconnects on its own.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Option, Predicate } from "effect";
import { useEffect, useSyncExternalStore } from "react";
import { builtVersion } from "../version.ts";
import { applyState, parseState } from "./state.ts";

export type LiveUpdates = ReturnType<typeof createLiveUpdates>;

export function createLiveUpdates(queryClient: QueryClient) {
  let open = false;
  let updated = false;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setOpen = (value: boolean) => {
    if (open === value) return;

    open = value;
    notify();
  };

  return {
    /** Listens to `/admin/events` until the returned function is called. */
    start: () => {
      const source = new EventSource("/admin/events");

      source.addEventListener("state", (event) => {
        if (!Predicate.hasProperty(event, "data") || !Predicate.isString(event.data)) return;

        Option.map(parseState(event.data), (state) => {
          applyState(queryClient, state);
          setOpen(true);

          // via restarted on another build, and the browser reconnected to it.
          if (state.version !== builtVersion && !updated) {
            updated = true;
            notify();
          }
        });
      });

      // The usage history is too big to push, so via only says it changed. Its queries
      // fetch again, but not a request list with more pages loaded: that fetches every
      // page it holds, and a list read further holds still.
      source.addEventListener("history", () => {
        setOpen(true);

        void queryClient.invalidateQueries({
          queryKey: ["history"],
          predicate: (query) =>
            !(
              query.queryKey[1] === "requests" &&
              Predicate.hasProperty(query.state.data, "pages") &&
              Array.isArray(query.state.data.pages) &&
              query.state.data.pages.length > 1
            ),
        });
      });

      source.addEventListener("error", () => setOpen(false));

      return () => {
        source.close();
        setOpen(false);
      };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    /** Whether via is pushing the state now. */
    isOpen: () => open,
    /** Whether via said it runs another version than this page was built with. */
    isUpdated: () => updated,
  };
}

/** Listens to `/admin/events` for as long as the calling component is mounted. */
export function useLiveUpdates() {
  const { live } = useRouteContext({ from: "__root__" });

  useEffect(() => live.start(), [live]);
}

/**
 * What a query that via pushes needs while the stream is open: no polling, and
 * no refetch, as what the cache holds is already the latest.
 */
const pushed = { refetchInterval: false, staleTime: Infinity } as const;

/**
 * Options to spread over a query that via pushes: `pushed` while the stream is
 * open, else none. The caller renders again when the stream opens or drops.
 */
export function useLiveOptions() {
  const { live } = useRouteContext({ from: "__root__" });

  return useSyncExternalStore(live.subscribe, live.isOpen) ? pushed : {};
}

/** A query via says has changed, while the stream is open: a `history` event fetches it again. */
const signalled = { refetchInterval: false } as const;

/**
 * Options to spread over a query that via says has changed, the usage page's:
 * no polling while the stream is open, else none.
 */
export function useSignalledOptions() {
  const { live } = useRouteContext({ from: "__root__" });

  return useSyncExternalStore(live.subscribe, live.isOpen) ? signalled : {};
}

/** Whether via runs another version than this page was built with, so the page is out of date. */
export function useViaUpdated() {
  const { live } = useRouteContext({ from: "__root__" });

  return useSyncExternalStore(live.subscribe, live.isUpdated);
}
