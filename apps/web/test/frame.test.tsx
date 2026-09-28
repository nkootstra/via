import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { themeScript } from "@via/ui";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorScreen } from "../src/components/error-screen.tsx";
import { renderApp, userMenu } from "./app.tsx";

/** The browser chrome's colour the page asks for, in a colour scheme. */
const tint = (scheme: string) =>
  document
    .querySelector(`meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`)
    ?.getAttribute("content");

/** The chrome's colour on an OS in `scheme`: the first theme-color whose media matches, or has none. */
const chrome = (scheme: string) =>
  [...document.querySelectorAll('meta[name="theme-color"]')]
    .find((meta) => {
      const media = meta.getAttribute("media");

      return media === null || media.includes(scheme);
    })
    ?.getAttribute("content");

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
  document.documentElement.removeAttribute("style");
});

describe("the document", () => {
  it("tints the browser's chrome with the page's background, light and dark", async () => {
    renderApp("/sign-in", { signedIn: false });
    await screen.findByRole("heading", { name: "Sign in" });

    expect(tint("light")).toBe("#FAFAFA");
    expect(tint("dark")).toBe("#171717");
  });

  it("tints the chrome with a stored theme over the OS's, until System", async () => {
    localStorage.setItem("via.theme", "dark");
    const { user } = renderApp("/");
    await screen.findByRole("heading", { name: "Overview" });
    // A client render resets <html>'s attributes, which hydration keeps; the
    // theme script puts the stored choice back, and the app hears of it as it
    // would of another tab's.
    new Function(themeScript)();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "via.theme", newValue: "dark" }));
    });

    expect(chrome("light")).toBe("#171717");
    expect(chrome("dark")).toBe("#171717");

    await user.click(userMenu());
    await user.click(await screen.findByRole("menuitemradio", { name: "System" }));

    expect(chrome("light")).toBe("#FAFAFA");
    expect(chrome("dark")).toBe("#171717");
  });
});

describe("the dashboard's frame", () => {
  it("offers the theme and signing out in the admin's menu", async () => {
    const { user } = renderApp("/");
    await screen.findByRole("heading", { name: "Overview" });

    await user.click(userMenu());

    const menu = await screen.findByRole("menu");
    const theme = within(menu).getByRole("group", { name: "Theme" });
    expect(within(theme).getAllByRole("menuitemradio")).toHaveLength(3);
    expect(within(menu).getByRole("menuitem", { name: "Sign out…" })).toBeDefined();
  });

  it("offers to skip to the page first, which moves focus to it", async () => {
    const { user } = renderApp("/");
    await screen.findByRole("heading", { name: "Overview" });

    await user.tab();

    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(document.activeElement).toBe(skip);
    const main = screen.getByRole("main");
    expect(skip.getAttribute("href")).toBe(`#${main.id}`);

    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(main);
  });

  it("moves focus to the new page's heading after following a link in the navigation", async () => {
    const { user } = renderApp("/");
    await screen.findByRole("heading", { name: "Overview" });

    await user.click(
      within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name: "Keys" }),
    );

    const heading = await screen.findByRole("heading", { name: "Keys", level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("leaves focus alone on the first page it shows", async () => {
    renderApp("/keys");
    await screen.findByRole("heading", { name: "Keys", level: 1 });

    expect(document.activeElement).toBe(document.body);
  });

  it("marks the page the viewer is on in the navigation", async () => {
    renderApp("/keys");
    await screen.findByRole("heading", { name: "Keys" });

    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(within(nav).getByRole("link", { name: "Keys" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Overview" }).hasAttribute("aria-current")).toBe(
      false,
    );
  });
});

describe("the error screen", () => {
  it("says what went wrong when a page can't load, and tries again", async () => {
    const { user } = renderApp("/", {}, [
      http.get("*/admin/session", () => HttpResponse.error(), { once: true }),
    ]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load this page");
    expect(alert.textContent).toContain("Can't reach via");

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeDefined();
  });

  it("says how to fix it when the failure has no message of its own", async () => {
    const rootRoute = createRootRoute({
      component: () => <ErrorScreen error={"not an Error"} reset={() => {}} />,
    });

    const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });

    render(<RouterProvider router={router} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Check that via is running, then try again.",
    );
  });
});
