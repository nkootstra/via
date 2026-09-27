import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createAppRouter } from "../src/router.tsx";
import { adminHandlers, createAdminState, type AdminState } from "../src/testing/admin-handlers.ts";

/** Stands in for via's /admin; a request no handler expects fails the test. */
export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => server.resetHandlers());

afterAll(() => server.close());

/** Renders the app at `path` (under /ui) against a fake via holding `state`. */
export function renderApp(path: string, seed: Partial<AdminState> = {}) {
  const state = createAdminState(seed);
  server.use(...adminHandlers(state));

  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/ui${path}`] }));
  const user = userEvent.setup();
  // The root route renders the whole document, <html> down, as Start does.
  render(<RouterProvider router={router} />, { container: document, baseElement: document.body });

  return { state, router, user };
}
