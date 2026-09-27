import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { delay, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { account, opencodeGoAccount } from "../src/testing/admin-handlers.ts";
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

const opencodeGo = [
  {
    id: "go-1",
    label: "go main",
    enabled: true,
    state: {
      status: "cooling",
      until: new Date(now + 2 * 3_600_000).toISOString(),
      reason: "usage_exhausted",
    },
  },
  {
    id: "go-2",
    label: "go spare",
    enabled: true,
    state: { status: "auth_error", reason: "unauthorized" },
  },
] as const;

const providers = [{ name: "openrouter", state: { status: "available" } }] as const;

const pool = { accounts: [...accounts], opencodeGo: [...opencodeGo], providers: [...providers] };

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
  opencodeGo: [
    {
      id: "go-1",
      label: "go main",
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
    {
      id: "go-2",
      label: "go spare",
      fetchedAt,
      error: "opencode-go did not report usage (HTTP 401)",
    },
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
      pool: { accounts: [accounts[0]], opencodeGo: [], providers: [] },
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
        opencodeGo: [],
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

  it("shows each OpenCode Go account as a card of its own, with its budget windows", async () => {
    renderApp("/", { pool, usage });

    const go = await card("go main");
    expect(within(go).getByText("OpenCode Go")).toBeDefined();
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

  it("counts a used-up OpenCode Go account down to its window's reset", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    renderApp("/", { pool, usage });

    const go = await card("go main");
    expect(within(go).getByText("Cooling down")).toBeDefined();
    expect(within(go).getByText(/usage_exhausted/)).toBeDefined();
    expect(within(go).getByText("2 h 00 min")).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(61_000));

    expect(within(go).getByText("1 h 58 min")).toBeDefined();
  });

  it("says when OpenCode Go refused an account's key", async () => {
    renderApp("/", { pool, usage });

    const spare = await card("go spare");
    expect(within(spare).getByText("Locked out")).toBeDefined();
    expect(within(spare).getByText("OpenCode Go refused its key")).toBeDefined();
  });

  it("counts OpenCode Go accounts and providers with the accounts in the summary", async () => {
    renderApp("/", { pool, usage });

    expect(await tile("Available")).toBe("2 of 6");
    expect(await tile("Resting")).toBe("2");
    expect(await tile("Needs attention")).toBe("2");
    expect(await tile("Disabled")).toBe("0");
  });

  it("shows the providers even before any account is added", async () => {
    renderApp("/", { pool: { accounts: [], opencodeGo: [], providers: [...providers] }, usage });

    expect(await screen.findByRole("region", { name: "No accounts yet" })).toBeDefined();
    expect(await card("openrouter")).toBeDefined();
  });

  it("invites the viewer to add an account when the pool is empty, right there", async () => {
    const { user, router } = renderApp("/");

    const empty = await screen.findByRole("region", { name: "No accounts yet" });
    await user.click(within(empty).getByRole("button", { name: "Add account" }));
    const choose = await screen.findByRole("dialog", { name: "Add an account" });
    await user.click(within(choose).getByRole("button", { name: /ChatGPT \(Codex\)/ }));

    expect(await screen.findByRole("dialog", { name: "Add a ChatGPT account" })).toBeDefined();
    expect(router.history.location.pathname).toBe("/ui/");
  });

  it("adds an OpenCode Go key from the overview, and shows it there", async () => {
    const { state, user } = renderApp("/", { pool, usage });

    await card("work");
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /OpenCode Go/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenCode Go key" });
    await user.type(within(dialog).getByLabelText("API key"), "sk-go-new-9876");
    await user.click(within(dialog).getByRole("button", { name: "Add key" }));

    expect(await card("OpenCode Go …9876")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add an OpenCode Go key" })).toBeNull(),
    );
    expect(state.opencodeGo.map(({ key }) => key)).toEqual(["…9876"]);
  });

  it("says so when OpenCode Go refuses a pasted key, and keeps the dialog open", async () => {
    const { state, user } = renderApp("/", { pool, usage, refusedKeys: ["sk-wrong"] });

    await card("work");
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /OpenCode Go/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenCode Go key" });
    await user.type(within(dialog).getByLabelText("API key"), "sk-wrong");
    await user.click(within(dialog).getByRole("button", { name: "Add key" }));

    expect(await within(dialog).findByText(/OpenCode Go refused this key/)).toBeDefined();
    expect(state.opencodeGo).toEqual([]);
  });

  it("says so when a pasted OpenCode Go key is already in the pool", async () => {
    const stored = opencodeGoAccount({ id: "go-1", label: "go main", key: "…1234" });
    const { state, user } = renderApp("/", { pool, usage, opencodeGo: [stored] });

    await card("work");
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /OpenCode Go/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenCode Go key" });
    await user.type(within(dialog).getByLabelText("API key"), "sk-go-1234");
    await user.click(within(dialog).getByRole("button", { name: "Add key" }));

    expect(
      await within(dialog).findByText("That key is already in the pool, as go main."),
    ).toBeDefined();
    expect(state.opencodeGo).toEqual([stored]);
  });

  it("puts a locked-out account back in rotation once it signs in again", async () => {
    const { user } = renderApp("/", {
      pool,
      usage,
      nextLogin: [{ status: "updated", account: account({ id: "acc-3", label: "spare" }) }],
    });

    expect(within(await card("spare")).getByText("Locked out")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));

    expect(await screen.findByRole("dialog", { name: "Signed in again" })).toBeDefined();
    await waitFor(() =>
      expect(
        within(screen.getByRole("article", { name: "spare" })).getByText("Available"),
      ).toBeDefined(),
    );
  });

  it("shows an account added from the overview there, once its login is approved", async () => {
    const { user, router } = renderApp("/", {
      pool,
      usage,
      nextLogin: [{ status: "added", account: account({ id: "acc-9", label: "new" }) }],
    });

    await card("work");
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));

    expect(await card("new")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add a ChatGPT account" })).toBeNull(),
    );
    expect(router.history.location.pathname).toBe("/ui/");
  });
});

/** Handlers for the overview's reads that never answer: nothing comes from via. */
const silent = ["/session", "/pool", "/usage", "/accounts"].map((path) =>
  http.get(`*/admin${path}`, () => delay("infinite")),
);

describe("the overview's usage", () => {
  it("paints what the tab kept at once after a reload, before via answers", async () => {
    renderApp("/", { pool, usage });
    await card("work");
    cleanup();

    renderApp("/", {}, silent);

    const work = await card("work");
    expect(within(work).getByRole("meter", { name: "5 hours" }).getAttribute("aria-valuenow")).toBe(
      "42",
    );
    expect(screen.queryByLabelText("Loading accounts")).toBeNull();
  });

  it("forgets what the tab kept once the viewer signs out", async () => {
    const { user } = renderApp("/", { pool, usage });
    await card("work");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Sign out of via?" });
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in" });
    cleanup();

    const { router } = renderApp("/", { signedIn: false }, silent.slice(1));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeDefined();
    expect(router.history.location.pathname).toBe("/ui/sign-in");
    expect(screen.queryByRole("article", { name: "work" })).toBeNull();
  });

  it("forgets what the tab kept once via answers 401", async () => {
    const { state, user } = renderApp("/", { pool, usage });
    await card("work");
    state.signedIn = false;
    await user.click(screen.getByRole("link", { name: "Keys" }));
    await screen.findByRole("heading", { name: "Sign in" });
    cleanup();

    renderApp("/", { signedIn: false }, silent.slice(1));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeDefined();
    expect(screen.queryByRole("article", { name: "work" })).toBeNull();
  });

  it("says how long ago the usage was fetched, ticking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    renderApp("/", { pool, usage });

    const section = await screen.findByRole("region", { name: "Accounts and providers" });
    expect(await within(section).findByText("Updated 30 s ago")).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(within(section).getByText("Updated 35 s ago")).toBeDefined();
  });

  it("keeps the usage on screen, without skeletons, while it is fetched again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    const { state } = renderApp("/", { pool, usage });

    const work = await card("work");
    await within(work).findByRole("meter", { name: "5 hours" });
    const asked = state.requests.filter((request) => request === "GET /admin/usage").length;
    state.usage = { ...usage, refreshing: true };

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(state.requests.filter((request) => request === "GET /admin/usage").length).toBe(
      asked + 1,
    );
    expect(within(work).getByRole("meter", { name: "5 hours" })).toBeDefined();
    expect(within(work).queryByLabelText("Loading usage")).toBeNull();
    expect(screen.queryByLabelText("Loading accounts")).toBeNull();
  });

  it("shows bars loading only where via has no usage yet, asking every second until it has", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });

    const { state } = renderApp("/", {
      pool,
      usage: { accounts: usage.accounts.slice(0, 1), opencodeGo: [], refreshing: true },
    });

    const work = await card("work");
    expect(await within(work).findByRole("meter", { name: "5 hours" })).toBeDefined();
    expect(within(await card("home")).getByLabelText("Loading usage")).toBeDefined();
    expect(within(await card("go main")).getByLabelText("Loading usage")).toBeDefined();

    const asked = state.requests.filter((request) => request === "GET /admin/usage").length;
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(
      state.requests.filter((request) => request === "GET /admin/usage").length,
    ).toBeGreaterThanOrEqual(asked + 2);

    state.usage = usage;
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(await within(await card("home")).findByText(/ChatGPT didn't answer/)).toBeDefined();
    expect(screen.queryByLabelText("Loading usage")).toBeNull();
  });
});

describe("the navigation", () => {
  it("fetches a page's data as soon as the viewer points at its link", async () => {
    const { state, user } = renderApp("/", { pool, usage });
    await card("work");
    expect(state.requests).not.toContain("GET /admin/keys");

    await user.hover(screen.getByRole("link", { name: "Keys" }));

    await waitFor(() => expect(state.requests).toContain("GET /admin/keys"));
  });
});
