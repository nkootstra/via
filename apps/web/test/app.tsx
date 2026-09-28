import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { AdminState as ViaState } from "@via/server/admin-api";
import { Schema } from "effect";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { RequestHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createAppRouter } from "../src/router.tsx";
import { adminHandlers, createAdminState, type AdminState } from "../src/testing/admin-handlers.ts";

/** Stands in for via's /admin; a request no handler expects fails the test. */
export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => server.resetHandlers());

afterAll(() => server.close());

/**
 * Renders the app at `path` (under /ui) against a fake via holding `state`;
 * `handlers` answer ahead of the fake's own, such as one that never answers.
 */
export function renderApp(
  path: string,
  seed: Partial<AdminState> = {},
  handlers: ReadonlyArray<RequestHandler> = [],
) {
  const state = createAdminState(seed);
  server.use(...handlers, ...adminHandlers(state));

  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/ui${path}`] }));
  const user = userEvent.setup();
  // The root route renders the whole document, <html> down, as Start does.
  render(<RouterProvider router={router} />, { container: document, baseElement: document.body });

  return { state, router, user };
}

/**
 * Puts `state` in the page as via's shell does for a signed-in page: JSON in a
 * `#via-state` script, which the app reads when it starts.
 */
export function embed(state: typeof ViaState.Type) {
  const script = document.createElement("script");
  script.type = "application/json";
  script.id = "via-state";
  script.textContent = Schema.encodeSync(Schema.fromJsonString(ViaState))(state);
  document.head.append(script);
}

/** The sidebar's user row, which opens the admin's menu. */
export const userMenu = () => screen.getByRole("button", { name: "Admin" });

/** Opens the user menu once the dashboard shows, and finds its Sign out… item. */
export async function openSignOut(user: UserEvent) {
  await screen.findByRole("heading", { level: 1 });
  await user.click(userMenu());

  return screen.findByRole("menuitem", { name: "Sign out…" });
}
