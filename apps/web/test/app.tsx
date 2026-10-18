import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { AdminState as ViaState } from "@via/server/admin-api";
import { Schema } from "effect";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { FetchInterceptor } from "@mswjs/interceptors/fetch/web";
import type { RequestHandler } from "msw";
import { defineNetwork, InterceptorSource } from "msw/experimental";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { createAppRouter } from "../src/router.tsx";
import { adminHandlers, createAdminState, type AdminState } from "../src/testing/admin-handlers.ts";

/**
 * Stands in for via's /admin; a request no handler expects fails the test.
 * Not `setupServer` from msw/node: msw 3 intercepts there below Node's own
 * fetch, which Bun's isn't, so it patches the global `fetch` instead.
 */
export const server = defineNetwork({
  sources: [new InterceptorSource({ interceptors: [new FetchInterceptor()] })],
  onUnhandledFrame: "error",
});

beforeAll(() => server.enable());

afterEach(() => server.resetHandlers());

afterAll(() => server.disable());

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

/** Whether a mutation the app made still holds `secret`, in what it sent or what it got back. */
export const mutationsHold = (router: ReturnType<typeof renderApp>["router"], secret: string) =>
  router.options.context.queryClient
    .getMutationCache()
    .getAll()
    .some((mutation) =>
      JSON.stringify([mutation.state.variables, mutation.state.data]).includes(secret),
    );

/**
 * Fakes the clock the router's and Query's waits run on (`setTimeout`,
 * `setInterval` and `Date`), so that a test can `skip` a wait rather than sit
 * it out in real time. The fake clock still moves with the real one, as
 * Testing Library's own waits need; React's scheduler keeps its real timers.
 * The setup puts the real clock back after each test.
 */
export const fakeClock = () =>
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    shouldAdvanceTime: true,
  });

/** Moves the fake clock on by `ms` at once, running what falls due meanwhile. */
export const skip = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

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
