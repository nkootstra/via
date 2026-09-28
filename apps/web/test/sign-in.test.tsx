import { TooManySignInsError, Unauthorized } from "@via/server/admin-api";
import { act, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failure } from "../src/testing/admin-handlers.ts";
import { openSignOut, renderApp, server, userMenu } from "./app.tsx";

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

  it("shows the logo alone above the form, named for screen readers", async () => {
    renderApp("/sign-in", { signedIn: false });
    await screen.findByRole("heading", { name: "Sign in" });

    // The name is for assistive tech alone; the logo is what's drawn.
    const name = screen.getByText("via");
    expect(name.querySelector("svg")).toBeNull();
    expect(name.parentElement?.querySelector("svg")).not.toBeNull();
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

  it("says so when via takes the key but the browser doesn't keep the session", async () => {
    const { state, user } = renderApp("/sign-in", { signedIn: false });
    // The sign-in answers 204, but the cookie never comes back: every check stays 401.
    server.use(
      http.get("*/admin/session", () =>
        failure(
          Unauthorized,
          new Unauthorized({ message: "Missing or invalid admin key or session" }),
          401,
        ),
      ),
    );

    await signIn(user, state.adminKey);

    expect((await screen.findByRole("alert")).textContent).toContain("didn't keep the session");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
  });

  it("says a repeated wrong key again, so a screen reader hears it, without new words to see", async () => {
    const { user } = renderApp("/sign-in", { signedIn: false });

    await signIn(user, "not-the-key");
    const alert = await screen.findByRole("alert");
    const first = alert.textContent;
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(alert.textContent).not.toBe(first));
    expect(alert.textContent).toContain("That key isn't right. Check it and try again.");
    expect(within(alert).getByText("(attempt 2)")).toBeDefined();
  });

  it("keeps the alert up while the next key is checked, then says the new outcome in it", async () => {
    const { user } = renderApp("/sign-in", { signedIn: false });

    await signIn(user, "not-the-key");
    const alert = await screen.findByRole("alert");

    server.use(
      http.post("*/admin/session", async () => {
        await delay(200);

        return HttpResponse.error();
      }),
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("alert")).toBe(alert);
    await waitFor(() => expect(alert.textContent).toContain("Can't reach via"));
    expect(screen.getAllByRole("alert")).toEqual([alert]);
  });

  describe("after too many wrong keys", () => {
    afterEach(() => vi.useRealTimers());

    it("says so once, counts down apart from the alert, and holds the button until then", async () => {
      // The clock stands still until the test moves it; timeouts, which the
      // router and the fake via use, run as usual.
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
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
      expect(alert.textContent).toBe("Too many wrong keys. via is pausing sign-ins for a minute.");
      const left = screen.getByText("Try again in 1:00.");
      expect(alert.contains(left)).toBe(false);
      expect(left.getAttribute("aria-live")).toBe("off");
      expect(screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled")).toBe(true);

      act(() => vi.advanceTimersByTime(60_000));

      expect(await screen.findByText("You can try again now.")).toBeDefined();
      expect(screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled")).toBe(false);
    });
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
    const reveal = screen.getByRole("button", { name: "Show key" });
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    await user.click(reveal);
    expect(input.getAttribute("type")).toBe("text");
    // The name stays put; whether the key shows is the button's pressed state.
    expect(screen.getByRole("button", { name: "Show key" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(reveal);
    expect(input.getAttribute("type")).toBe("password");
  });

  it("says the session ended when via stops taking it", async () => {
    const { state, user } = renderApp("/", {});
    await screen.findByRole("heading", { name: "Overview" });
    state.signedIn = false;

    await user.click(screen.getByRole("link", { name: "Keys" }));

    expect(await screen.findByText("Your session ended. Sign in again.")).toBeDefined();
  });

  it("says nothing of a session to someone who hasn't signed in", async () => {
    renderApp("/sign-in", { signedIn: false });

    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.queryByText("Your session ended. Sign in again.")).toBeNull();
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

  it("asks before signing out, and sends nothing until confirmed", async () => {
    const { state, user } = renderApp("/");

    const signOut = await openSignOut(user);
    expect(signOut.hasAttribute("data-destructive")).toBe(true);
    await user.click(signOut);

    const dialog = await screen.findByRole("alertdialog", { name: "Sign out of via?" });
    expect(dialog.textContent).toContain("You'll need the admin key to sign in again.");
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
    );
    expect(state.requests).not.toContain("DELETE /admin/session");
  });

  it("stays signed in when the viewer cancels, back on the user menu", async () => {
    const { state, user, router } = renderApp("/");

    await user.click(await openSignOut(user));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(userMenu()));
    expect(state.signedIn).toBe(true);
    expect(state.requests).not.toContain("DELETE /admin/session");
    expect(router.history.location.pathname).toBe("/ui/");
  });

  it("stays signed in when the viewer presses Escape", async () => {
    const { state, user } = renderApp("/");

    await user.click(await openSignOut(user));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(userMenu()));
    expect(state.signedIn).toBe(true);
    expect(state.requests).not.toContain("DELETE /admin/session");
  });

  it("signs out once confirmed, and forgets the session", async () => {
    const { state, user, router } = renderApp("/");

    await user.click(await openSignOut(user));
    const dialog = await screen.findByRole("alertdialog", { name: "Sign out of via?" });
    const confirm = within(dialog).getByRole("button", { name: "Sign out" });
    expect(confirm.getAttribute("data-variant")).toBe("destructive");
    await user.click(confirm);

    await waitFor(() => expect(router.history.location.pathname).toBe("/ui/sign-in"));
    expect(state.signedIn).toBe(false);
    expect(state.requests).toContain("DELETE /admin/session");
  });
});
