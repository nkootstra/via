import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./app.tsx";

afterEach(() => localStorage.clear());

describe("the start page", () => {
  it("opens on the Overview until another is chosen", async () => {
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeDefined();
  });

  it("opens on the Usage page when it's chosen, and still goes to the Overview when asked", async () => {
    localStorage.setItem("via.start-page", "usage");
    const { user } = renderApp("/");

    expect(await screen.findByRole("heading", { name: "Usage", level: 1 })).toBeDefined();

    await user.click(screen.getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeDefined();
  });
});
