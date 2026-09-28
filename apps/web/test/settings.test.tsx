import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./app.tsx";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
  document.documentElement.removeAttribute("style");
});

const choice = (name: string) => screen.findByRole("radiogroup", { name });

const checked = (group: HTMLElement, name: string) =>
  within(group).getByRole("radio", { name }).getAttribute("aria-checked") === "true";

describe("the settings", () => {
  it("offer the theme, and change it at once", async () => {
    const { user } = renderApp("/settings");

    const theme = await choice("Theme");
    expect(checked(theme, "System")).toBe(true);

    await user.click(within(theme).getByRole("radio", { name: "Dark" }));

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("via.theme")).toBe("dark");
  });

  it("offer the time format, Automatic until chosen, and show how times will read", async () => {
    const { user } = renderApp("/settings");

    const format = await choice("Time format");
    expect(checked(format, "Automatic")).toBe(true);

    await user.click(within(format).getByRole("radio", { name: "24-hour" }));

    expect(localStorage.getItem("via.time-format")).toBe("24h");
    expect(screen.getByText(/15:30/)).toBeDefined();

    await user.click(within(format).getByRole("radio", { name: "12-hour" }));

    expect(screen.queryByText(/15:30/)).toBeNull();
    expect(screen.getByText(/3:30/)).toBeDefined();
  });

  it("have a page title of their own", async () => {
    renderApp("/settings");
    await screen.findByRole("heading", { name: "Settings", level: 1 });

    expect(document.title).toBe("Settings · via");
  });
});
