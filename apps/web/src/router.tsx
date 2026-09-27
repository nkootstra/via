import { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { onSignedOut } from "./api/client.ts";
import { persistQueries } from "./api/persist.ts";
import { routeTree } from "./routeTree.gen.ts";

/** The app's router; tests pass a memory history. */
export function createAppRouter(history?: RouterHistory) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  persistQueries(queryClient);

  const router = createRouter({
    routeTree,
    basepath: "/ui",
    context: { queryClient },
    defaultPreload: "intent",
    ...(history === undefined ? {} : { history }),
  });

  // A 401 anywhere means the session ended: forget what it showed, what the tab
  // kept of it included, and sign in.
  onSignedOut(() => {
    queryClient.clear();
    void router.navigate({ to: "/sign-in" });
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
