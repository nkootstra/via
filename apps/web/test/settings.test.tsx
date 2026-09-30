import { screen, waitFor, within } from "@testing-library/react";
import { Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./app.tsx";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
  delete document.documentElement.dataset["motion"];
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

  it("offer privacy mode, off until turned on", async () => {
    const { user } = renderApp("/settings");

    const privacy = await screen.findByRole("switch", { name: "Privacy mode" });
    expect(privacy.getAttribute("aria-checked")).toBe("false");

    await user.click(privacy);

    expect(privacy.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("via.privacy")).toBe("on");
  });

  it("offer to reduce motion, following the system until chosen", async () => {
    const { user } = renderApp("/settings");

    const motion = await choice("Motion");
    expect(checked(motion, "System")).toBe(true);

    await user.click(within(motion).getByRole("radio", { name: "Reduced" }));

    expect(localStorage.getItem("via.motion")).toBe("reduced");
    expect(document.documentElement.dataset["motion"]).toBe("reduced");

    await user.click(within(motion).getByRole("radio", { name: "System" }));
    expect(localStorage.getItem("via.motion")).toBeNull();
    expect(document.documentElement.dataset["motion"]).toBeUndefined();
  });

  it("offer the start page, Overview until chosen", async () => {
    const { user } = renderApp("/settings");

    const start = await choice("Start page");
    expect(checked(start, "Overview")).toBe(true);

    await user.click(within(start).getByRole("radio", { name: "Usage" }));

    expect(localStorage.getItem("via.start-page")).toBe("usage");
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

describe("deleting the usage history", () => {
  const kept = {
    requestId: "r1",
    at: 0,
    status: 200,
    error: Option.none(),
    errorMessage: Option.none(),
    streamEnd: Option.none(),
    keyId: Option.none(),
    keyName: Option.none(),
    model: "gpt-6-astra",
    provider: "codex",
    accountId: Option.none(),
    accountLabel: Option.none(),
    inputTokens: Option.some(1),
    cachedTokens: Option.none(),
    outputTokens: Option.some(1),
    reasoningTokens: Option.none(),
    costUsd: Option.none(),
    durationMs: 1,
    firstChunkMs: Option.none(),
  };

  it("asks first, then deletes every request via kept", async () => {
    const { state, user } = renderApp("/settings", { historyRequests: [kept] });

    await user.click(await screen.findByRole("button", { name: "Delete usage history…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete all usage history?" });
    expect(dialog.textContent).toContain("can't be undone");

    await user.click(within(dialog).getByRole("button", { name: "Delete history" }));

    await waitFor(() => expect(state.historyRequests).toEqual([]));
    expect(await screen.findByText("Usage history deleted")).toBeDefined();
  });

  it("keeps it all when the question is turned down", async () => {
    const { state, user } = renderApp("/settings", { historyRequests: [kept] });

    await user.click(await screen.findByRole("button", { name: "Delete usage history…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete all usage history?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(state.historyRequests).toHaveLength(1);
    expect(state.requests).not.toContain("DELETE /admin/history");
  });
});
