import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "./app.tsx";

const now = Date.parse("2026-09-27T12:00:00.000Z");

afterEach(() => vi.useRealTimers());

const pool = [
  { id: "acc-1", label: "work", enabled: true, state: { status: "available" } },
  {
    id: "acc-2",
    label: "home",
    enabled: true,
    state: {
      status: "cooling",
      until: new Date(now + 5 * 60_000).toISOString(),
      reason: "Usage limit reached",
    },
  },
  {
    id: "acc-3",
    label: "spare",
    enabled: true,
    state: { status: "auth_error", reason: "Refresh token revoked" },
  },
] as const;

const usage = {
  accounts: [
    {
      id: "acc-1",
      label: "work",
      windows: [
        { windowMinutes: 300, usedPercent: 42, resetsAt: "2026-09-27T14:00:00.000Z" },
        { windowMinutes: 10_080, usedPercent: 81, resetsAt: "2026-10-01T09:00:00.000Z" },
      ],
    },
    { id: "acc-2", label: "home", error: "ChatGPT didn't answer" },
  ],
  providers: [
    {
      provider: "opencode-go",
      windows: [
        {
          window: "monthly",
          status: "ok",
          usedPercent: 12,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    },
    { provider: "openrouter", error: "401 from the provider" },
  ],
};

const card = async (name: string) => screen.findByRole("article", { name });

describe("the overview", () => {
  it("shows each account's state and usage windows", async () => {
    renderApp("/", { pool: { accounts: [...pool], providers: [] }, usage });

    const work = await card("work");
    expect(within(work).getByText("Available")).toBeDefined();
    expect(
      (await within(work).findByRole("meter", { name: "5 hours" })).getAttribute("aria-valuenow"),
    ).toBe("42");
    expect(within(work).getByRole("meter", { name: "7 days" })).toBeDefined();

    const spare = await card("spare");
    expect(within(spare).getByText("Locked out")).toBeDefined();
    expect(within(spare).getByText("Refresh token revoked")).toBeDefined();

    expect(within(await card("home")).getByText(/ChatGPT didn't answer/)).toBeDefined();
  });

  it("counts a cooldown down every second", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    renderApp("/", { pool: { accounts: [...pool], providers: [] }, usage });

    const home = await card("home");
    expect(within(home).getByText("Cooling down")).toBeDefined();
    expect(within(home).getByText(/Usage limit reached/)).toBeDefined();
    const clock = within(home).getByText(/^\d+:\d\d$/);
    const before = clock.textContent;

    await act(() => vi.advanceTimersByTimeAsync(3_000));

    expect(clock.textContent).not.toBe(before);
    expect(clock.textContent).toMatch(/^4:5\d$/);
  });

  it("shows each provider's windows, or why it has none", async () => {
    renderApp("/", { pool: { accounts: [...pool], providers: [] }, usage });

    const go = await card("opencode-go");
    expect(within(go).getByRole("meter", { name: "monthly" })).toBeDefined();
    expect(within(await card("openrouter")).getByText(/401 from the provider/)).toBeDefined();
  });

  it("invites the viewer to add an account when the pool is empty", async () => {
    const { user, router } = renderApp("/");

    const empty = await screen.findByRole("region", { name: "No accounts yet" });
    await user.click(within(empty).getByRole("button", { name: "Add account" }));

    expect(await screen.findByRole("dialog", { name: "Add a ChatGPT account" })).toBeDefined();
    expect(router.history.location.pathname).toBe("/ui/accounts");
  });
});
