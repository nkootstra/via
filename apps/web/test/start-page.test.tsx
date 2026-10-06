import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./app.tsx";

afterEach(() => localStorage.clear());

describe("the start page", () => {
  it("opens on the Overview until another is chosen", async () => {
    const { router } = renderApp("/");

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeDefined();
    await waitFor(() => expect(router.history.location.pathname).toBe("/ui/overview"));
  });

  it("opens on the Usage page when it's chosen, and still goes to the Overview when asked", async () => {
    localStorage.setItem("via.start-page", "usage");
    const { user, router } = renderApp("/");

    expect(await screen.findByRole("heading", { name: "Usage", level: 1 })).toBeDefined();
    expect(router.history.location.pathname).toBe("/ui/usage");

    await user.click(screen.getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeDefined();
  });

  it("keeps the Overview at its own address when another page is chosen", async () => {
    localStorage.setItem("via.start-page", "usage");
    const { router } = renderApp("/overview");

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeDefined();
    expect(router.history.location.pathname).toBe("/ui/overview");
  });

  it("links the sidebar's Overview to its own address", async () => {
    localStorage.setItem("via.start-page", "usage");
    renderApp("/");

    await screen.findByRole("heading", { name: "Usage", level: 1 });
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("href")).toBe(
      "/ui/overview",
    );
  });

  it("takes the via logo to the start page", async () => {
    localStorage.setItem("via.start-page", "usage");
    const { user, router } = renderApp("/overview");

    await screen.findByRole("heading", { name: "Overview", level: 1 });
    await user.click(screen.getAllByRole("link", { name: "via" })[0]!);

    expect(await screen.findByRole("heading", { name: "Usage", level: 1 })).toBeDefined();
    expect(router.history.location.pathname).toBe("/ui/usage");
  });
});
