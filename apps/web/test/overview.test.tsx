import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "./app.tsx";

const now = Date.parse("2026-09-27T12:00:00.000Z");

afterEach(() => vi.useRealTimers());

const accounts = [
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

const providers = [
  {
    name: "opencode-go",
    state: {
      status: "exhausted",
      until: new Date(now + 2 * 3_600_000).toISOString(),
      window: "weekly",
    },
  },
  { name: "openrouter", state: { status: "available" } },
  {
    name: "local",
    state: { status: "unavailable", reason: "local did not report usage (HTTP 401)" },
  },
] as const;

const pool = { accounts: [...accounts], providers: [...providers] };

const fetchedAt = "2026-09-27T11:59:30.000Z";

const usage = {
  accounts: [
    {
      id: "acc-1",
      label: "work",
      fetchedAt,
      windows: [
        { windowMinutes: 300, usedPercent: 42, resetsAt: "2026-09-27T14:00:00.000Z" },
        { windowMinutes: 10_080, usedPercent: 81, resetsAt: "2026-10-01T09:00:00.000Z" },
      ],
    },
    { id: "acc-2", label: "home", fetchedAt, error: "ChatGPT didn't answer" },
  ],
  providers: [
    {
      provider: "opencode-go",
      fetchedAt,
      windows: [
        { window: "rolling", status: "ok", usedPercent: 40, resetsAt: "2026-09-27T16:00:00.000Z" },
        {
          window: "weekly",
          status: "rate-limited",
          usedPercent: 100,
          resetsAt: "2026-09-27T14:00:00.000Z",
        },
        { window: "monthly", status: "ok", usedPercent: 12, resetsAt: "2026-10-01T00:00:00.000Z" },
      ],
    },
    { provider: "local", fetchedAt, error: "local did not report usage (HTTP 401)" },
  ],
  refreshing: false,
};

const card = async (name: string) => screen.findByRole("article", { name });

/** A summary tile's figure, found by its label. */
const tile = async (label: string) =>
  (await screen.findByText(label, { selector: "dt" })).nextElementSibling?.textContent;

describe("the overview", () => {
  it("shows each account's state and usage windows", async () => {
    renderApp("/", { pool, usage });

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

  it("shows only the weekly window of a plan without a 5-hour one", async () => {
    renderApp("/", {
      pool: { accounts: [accounts[0]], providers: [] },
      usage: {
        accounts: [
          {
            id: "acc-1",
            label: "work",
            fetchedAt,
            windows: [
              { windowMinutes: 10_080, usedPercent: 30, resetsAt: "2026-10-01T09:00:00.000Z" },
            ],
          },
        ],
        providers: [],
        refreshing: false,
      },
    });

    const work = await card("work");
    expect(await within(work).findByRole("meter", { name: "7 days" })).toBeDefined();
    expect(within(work).queryByRole("meter", { name: "5 hours" })).toBeNull();
  });

  it("counts a cooldown down every second", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    renderApp("/", { pool, usage });

    const home = await card("home");
    expect(within(home).getByText("Cooling down")).toBeDefined();
    expect(within(home).getByText(/Usage limit reached/)).toBeDefined();
    const clock = within(home).getByText(/^\d+:\d\d$/);
    const before = clock.textContent;

    await act(() => vi.advanceTimersByTimeAsync(3_000));

    expect(clock.textContent).not.toBe(before);
    expect(clock.textContent).toMatch(/^4:5\d$/);
  });

  it("shows a provider as a card like an account's, with its budget windows", async () => {
    renderApp("/", { pool, usage });

    const go = await card("opencode-go");
    expect(within(go).getByText("Provider")).toBeDefined();
    expect(
      (await within(go).findByRole("meter", { name: "5 hours" })).getAttribute("aria-valuenow"),
    ).toBe("40");
    expect(within(go).getByRole("meter", { name: "Weekly" }).getAttribute("aria-valuenow")).toBe(
      "100",
    );
    expect(within(go).getByRole("meter", { name: "Monthly" })).toBeDefined();

    const openrouter = await card("openrouter");
    expect(within(openrouter).getByText("Provider")).toBeDefined();
    expect(within(openrouter).getByText("Available")).toBeDefined();
    expect(await within(openrouter).findByText(/doesn't report usage/)).toBeDefined();
  });

  it("counts an exhausted provider down to its window's reset", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    renderApp("/", { pool, usage });

    const go = await card("opencode-go");
    expect(within(go).getByText("Exhausted")).toBeDefined();
    expect(within(go).getByText(/Weekly limit used up/)).toBeDefined();
    expect(within(go).getByText("2 h 00 min")).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(61_000));

    expect(within(go).getByText("1 h 58 min")).toBeDefined();
  });

  it("says why a provider is unavailable, once", async () => {
    renderApp("/", { pool, usage });

    const local = await card("local");
    expect(within(local).getByText("Unavailable")).toBeDefined();
    expect(await within(local).findAllByText(/HTTP 401/)).toHaveLength(1);
  });

  it("counts providers with the accounts in the summary", async () => {
    renderApp("/", { pool, usage });

    expect(await tile("Available")).toBe("2 of 6");
    expect(await tile("Resting")).toBe("2");
    expect(await tile("Needs attention")).toBe("2");
    expect(await tile("Disabled")).toBe("0");
  });

  it("shows the providers even before any account is added", async () => {
    renderApp("/", { pool: { accounts: [], providers: [...providers] }, usage });

    expect(await screen.findByRole("region", { name: "No accounts yet" })).toBeDefined();
    expect(await card("opencode-go")).toBeDefined();
  });

  it("invites the viewer to add an account when the pool is empty", async () => {
    const { user, router } = renderApp("/");

    const empty = await screen.findByRole("region", { name: "No accounts yet" });
    await user.click(within(empty).getByRole("button", { name: "Add account" }));

    expect(await screen.findByRole("dialog", { name: "Add a ChatGPT account" })).toBeDefined();
    expect(router.history.location.pathname).toBe("/ui/accounts");
  });
});
