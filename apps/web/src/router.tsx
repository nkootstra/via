import { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { onSignedOut } from "./api/client.ts";
import { createLiveUpdates } from "./api/live.ts";
import { applyEmbeddedState } from "./api/state.ts";
import { routeTree } from "./routeTree.gen.ts";

/** The app's router; tests pass a memory history. */
export function createAppRouter(history?: RouterHistory) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  // A signed-in page's shell carries the admin state: the first render needs no request.
  applyEmbeddedState(queryClient);

  const router = createRouter({
    routeTree,
    basepath: "/ui",
    context: { queryClient, live: createLiveUpdates(queryClient) },
    // Loaders only ensure queries' data, and Query decides whether it's fresh,
    // so the router runs them on every preload rather than caching their results.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    ...(history === undefined ? {} : { history }),
  });

  // A 401 anywhere means the session ended: forget what it showed, and sign in, told why.
  onSignedOut(() => {
    queryClient.clear();
    void router.navigate({ to: "/sign-in", search: { expired: true } });
  });

  return router;
}

/** Start's entry point for the router. */
export function getRouter() {
  return createAppRouter();
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
