import { TooManySignInsError } from "@via/server/admin-api";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { failure } from "../src/testing/admin-handlers.ts";
import { renderApp, server } from "./app.tsx";

const signIn = async (user: ReturnType<typeof renderApp>["user"], key: string) => {
  await user.type(await screen.findByLabelText("Admin key"), key);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("signing in", () => {
  it("sends a visitor without a session to sign in", async () => {
    const { router } = renderApp("/keys", { signedIn: false });

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeDefined();
    expect(router.history.location.pathname).toBe("/ui/sign-in");
  });

  it("signs in with the admin key and lands where the visitor was going", async () => {
    const { state, user, router } = renderApp("/keys", { signedIn: false });

    await signIn(user, state.adminKey);

    expect(await screen.findByRole("heading", { name: "Keys" })).toBeDefined();
    expect(state.signedIn).toBe(true);
    expect(router.history.location.pathname).toBe("/ui/keys");
  });

  it("says so when the key is wrong, and stays on the form", async () => {
    const { state, user } = renderApp("/sign-in", { signedIn: false });

    await signIn(user, "not-the-key");

    expect((await screen.findByRole("alert")).textContent).toContain("That key isn't right");
    expect(state.signedIn).toBe(false);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
  });

  it("says when to try again after too many wrong keys, and holds the button until then", async () => {
    const { user } = renderApp("/sign-in", { signedIn: false });
    server.use(
      http.post("*/admin/session", () =>
        failure(
          TooManySignInsError,
          new TooManySignInsError({ message: "Too many failed sign-ins; try later" }),
          429,
        ),
      ),
    );

    await signIn(user, "guess");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Too many wrong keys.*try again in 1:00/);
    expect(screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled")).toBe(true);
  });

  it("says so when via can't be reached", async () => {
    const { user } = renderApp("/sign-in", { signedIn: false });
    server.use(http.post("*/admin/session", () => HttpResponse.error()));

    await signIn(user, "the-key");

    expect((await screen.findByRole("alert")).textContent).toContain("Can't reach via");
  });

  it("shows and hides the key", async () => {
    const { user } = renderApp("/sign-in", { signedIn: false });
    const input = await screen.findByLabelText("Admin key");

    expect(input.getAttribute("type")).toBe("password");
    await user.click(screen.getByRole("button", { name: "Show key" }));
    expect(input.getAttribute("type")).toBe("text");
    await user.click(screen.getByRole("button", { name: "Hide key" }));
    expect(input.getAttribute("type")).toBe("password");
  });

  it("goes straight to the dashboard with a session", async () => {
    const { router } = renderApp("/sign-in");

    await waitFor(() => expect(router.history.location.pathname).toBe("/ui/"));
  });
});

describe("the session", () => {
  it("sends the viewer to sign in when any call later answers 401", async () => {
    const { state, user, router } = renderApp("/keys");
    await screen.findByRole("heading", { name: "Keys" });

    state.signedIn = false;
    await user.click(screen.getByRole("link", { name: "Accounts" }));

    await waitFor(() => expect(router.history.location.pathname).toBe("/ui/sign-in"));
  });

  it("signs out and forgets the session", async () => {
    const { state, user, router } = renderApp("/");

    const signOut = await screen.findByRole("button", { name: "Sign out" });
    expect(signOut.getAttribute("data-variant")).toBe("ghost-destructive");
    await user.click(signOut);

    await waitFor(() => expect(router.history.location.pathname).toBe("/ui/sign-in"));
    expect(state.signedIn).toBe(false);
    expect(state.requests).toContain("DELETE /admin/session");
  });
});
