import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { account, opencodeGoAccount } from "../src/testing/admin-handlers.ts";
import { breakdown, cost, group } from "../src/testing/history.ts";
import { embed, fakeClock, openSignOut, renderApp, skip } from "./app.tsx";
import { FakeEventSource, openSource } from "./event-source.ts";

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
      reason: "usage_limit_reached",
    },
  },
  {
    id: "acc-3",
    label: "spare",
    enabled: true,
    state: { status: "auth_error", reason: "refresh_token_expired" },
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
      reason: "weekly_exhausted",
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
  openrouter: null,
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
    expect(within(work).getByRole("meter", { name: "Weekly" })).toBeDefined();

    const spare = await card("spare");
    expect(within(spare).getByText("Locked out")).toBeDefined();
    expect(within(spare).getByText("ChatGPT signed this account out")).toBeDefined();

    expect(within(await card("home")).getByText(/ChatGPT didn't answer/)).toBeDefined();
  });

  it("says what to do about an account whose usage couldn't be read", async () => {
    renderApp("/", { pool, usage });

    const home = await card("home");
    expect(await within(home).findByText(/ChatGPT didn't answer/)).toBeDefined();
    expect(within(home).getByText(/via asks again on its next refresh/)).toBeDefined();

    const go = await card("go spare");
    expect(
      within(go).getByText(
        "Usage unavailable: OpenCode Go did not report usage (HTTP 401). via asks again on its next refresh.",
      ),
    ).toBeDefined();
  });

  it("says how to sign a locked-out account in again", async () => {
    renderApp("/", { pool, usage, accounts: [account({ id: "acc-3", label: "spare" })] });

    expect(
      await within(await card("spare")).findByText(
        "Sign in again: choose Add account and sign in to spare@example.com.",
      ),
    ).toBeDefined();
  });

  it("names each card with a heading, and keeps a cut-short name whole on hover", async () => {
    renderApp("/", { pool, usage });

    const heading = await screen.findByRole("heading", { level: 3, name: "work" });
    expect(heading.getAttribute("title")).toBe("work");
    expect(await card("work")).toBeDefined();
  });

  it("says when a cooldown is about to end, rather than counting down past it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: now + 10 * 60_000 });
    renderApp("/", { pool, usage });

    expect(within(await card("home")).getByText("Back any moment")).toBeDefined();
  });

  it("says the overview couldn't be loaded, rather than that there are no accounts", async () => {
    const { user } = renderApp("/", { pool, usage }, [
      http.get("*/admin/pool", () => new HttpResponse(null, { status: 500 }), { once: true }),
    ]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the pool");
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "No accounts yet" })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await card("work")).toBeDefined();
  });

  it("titles the empty pool as a section of the page", async () => {
    renderApp("/");

    expect(await screen.findByRole("heading", { level: 2, name: "No accounts yet" })).toBeDefined();
  });

  it("announces that the pool is loading, on a page without the shell's state", async () => {
    fakeClock();
    renderApp("/", {}, [http.get("*/admin/pool", () => delay("infinite"))]);

    // The router shows it once loading takes a moment, 1 s.
    await skip(1_000);
    expect((await screen.findByRole("status")).textContent).toBe("Loading accounts…");
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
        openrouter: null,
        refreshing: false,
      },
    });

    const work = await card("work");
    expect(await within(work).findByRole("meter", { name: "Weekly" })).toBeDefined();
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

    const openrouter = await card("OpenRouter");
    expect(within(openrouter).getByText("Provider")).toBeDefined();
    expect(within(openrouter).getByText("Available")).toBeDefined();
    expect(await within(openrouter).findByText("No requests in the last 24 hours.")).toBeDefined();
  });

  it("counts a used-up OpenCode Go account down to its window's reset", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    renderApp("/", { pool, usage });

    const go = await card("go main");
    expect(within(go).getByText("Cooling down")).toBeDefined();
    expect(within(go).getByText(/Weekly limit used up/)).toBeDefined();
    expect(within(go).getByText("2 h 00 min")).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(61_000));

    expect(within(go).getByText("1 h 58 min")).toBeDefined();
  });

  it("says when OpenCode Go refused an account's key", async () => {
    renderApp("/", { pool, usage });

    const spare = await card("go spare");
    expect(within(spare).getByText("Locked out")).toBeDefined();
    expect(within(spare).getByText("OpenCode Go refused this key.")).toBeDefined();
    expect(within(spare).getByText("Remove the account and add it with a new key.")).toBeDefined();
    expect(within(spare).queryByText("unauthorized")).toBeNull();
  });

  it("counts OpenCode Go accounts and providers with the accounts in the summary", async () => {
    renderApp("/", { pool, usage });

    expect(await tile("Available")).toBe("2 of 6");
    expect(await tile("Cooling down or exhausted")).toBe("2");
    expect(await tile("Locked out or unavailable")).toBe("2");
    expect(await tile("Disabled")).toBe("0");
  });

  it("shows the providers even before any account is added", async () => {
    renderApp("/", { pool: { accounts: [], opencodeGo: [], providers: [...providers] }, usage });

    expect(await screen.findByRole("region", { name: "No accounts yet" })).toBeDefined();
    expect(await card("OpenRouter")).toBeDefined();
  });

  it("shows what via counted for each provider over the last day, as they report no usage", async () => {
    const { state } = renderApp("/", {
      pool: {
        ...pool,
        providers: [...providers, { name: "ollama", state: { status: "available" } }],
      },
      usage,
      historyBreakdown: new Map([
        [
          "account",
          breakdown([
            group({ group: "acc-1", requests: 40 }),
            group({
              group: "provider:ollama",
              requests: 2,
              inputTokens: 457,
              outputTokens: 3,
              cost: cost(0),
            }),
            group({ group: "provider:openrouter", requests: 15, cost: cost(0, 0.42) }),
          ]),
        ],
      ]),
    });

    /** Each of a card's figures: its value, and the line under it. */
    const figures = async (name: string) => {
      const figure = within(await card(name));
      await figure.findByText("Requests");

      return Object.fromEntries(
        figure.getAllByRole("term").map((term) => {
          const value = term.nextElementSibling;

          return [term.textContent, [value?.textContent, value?.nextElementSibling?.textContent]];
        }),
      );
    };

    expect(await figures("Ollama")).toEqual({
      Requests: ["2", "Last 24 hours · 4% of via's requests"],
      Tokens: ["460", "457 in · 3 out"],
      Cost: ["Free", "No one billed these tokens"],
    });
    expect(await figures("OpenRouter")).toEqual({
      Requests: ["15", "Last 24 hours · 26% of via's requests"],
      Tokens: ["1.2K", "1K in · 200 out"],
      Cost: ["$0.42", "Billed by OpenRouter"],
    });

    const link = within(await card("Ollama")).getByRole("link", { name: "See its requests" });
    expect(link.getAttribute("href")).toContain("account=provider%3Aollama");

    const query = state.historyQueries.at(-1);
    expect(query?.get("groupBy")).toBe("account");
    expect(Number(query?.get("to")) - Number(query?.get("from"))).toBe(86_400_000);
  });

  it("shows an OpenRouter key's budget as a meter, as the accounts' limits are", async () => {
    renderApp("/", {
      pool,
      usage: {
        ...usage,
        openrouter: {
          fetchedAt,
          budget: {
            limitUsd: 10,
            spentUsd: 3.2,
            window: "monthly",
            resetsAt: "2026-10-01T00:00:00.000Z",
          },
        },
      },
    });

    const openrouter = within(await card("OpenRouter"));
    const meter = openrouter.getByRole("meter", { name: "Monthly budget" });
    expect(meter.getAttribute("aria-valuenow")).toBe("32");
    expect(openrouter.getByText(/^\$3\.20 of \$10\.00 · Resets /)).toBeDefined();
  });

  it("says a budget that never resets doesn't, and shows none for a key without one", async () => {
    renderApp("/", {
      pool,
      usage: {
        ...usage,
        openrouter: {
          fetchedAt,
          budget: { limitUsd: 5, spentUsd: 5, window: null, resetsAt: null },
        },
      },
    });

    const openrouter = within(await card("OpenRouter"));
    expect(openrouter.getByRole("meter", { name: "Budget" }).getAttribute("aria-valuenow")).toBe(
      "100",
    );
    expect(openrouter.getByText("$5.00 of $5.00, never resets")).toBeDefined();

    cleanup();
    renderApp("/", { pool, usage: { ...usage, openrouter: { fetchedAt, budget: null } } });
    const unlimited = within(await screen.findByRole("article", { name: "OpenRouter" }));
    expect(unlimited.queryByRole("meter")).toBeNull();
  });

  it("says why OpenRouter's budget couldn't be read", async () => {
    renderApp("/", {
      pool,
      usage: { ...usage, openrouter: { fetchedAt, error: "OpenRouter didn't answer" } },
    });

    const openrouter = within(await card("OpenRouter"));
    expect(openrouter.getByText(/Budget unavailable: OpenRouter didn't answer/)).toBeDefined();
  });

  it("says when a provider served nothing over the last day", async () => {
    renderApp("/", { pool, usage });

    expect(
      await within(await card("OpenRouter")).findByText("No requests in the last 24 hours."),
    ).toBeDefined();
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
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenCode Go account" });
    await user.type(within(dialog).getByLabelText("API key"), "sk-go-new-9876");
    await user.click(within(dialog).getByRole("button", { name: "Add account" }));

    expect(await card("OpenCode Go …9876")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add an OpenCode Go account" })).toBeNull(),
    );
    expect(state.opencodeGo.map(({ key }) => key)).toEqual(["…9876"]);
  });

  it("says so when OpenCode Go refuses a pasted key, and keeps the dialog open", async () => {
    const { state, user } = renderApp("/", { pool, usage, refusedKeys: ["sk-wrong"] });

    await card("work");
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /OpenCode Go/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenCode Go account" });
    await user.type(within(dialog).getByLabelText("API key"), "sk-wrong");
    await user.click(within(dialog).getByRole("button", { name: "Add account" }));

    expect(await within(dialog).findByText(/OpenCode Go refused this key/)).toBeDefined();
    expect(state.opencodeGo).toEqual([]);
  });

  it("says so when a pasted OpenCode Go key is already in the pool", async () => {
    const stored = opencodeGoAccount({ id: "go-1", label: "go main", key: "…1234" });
    const { state, user } = renderApp("/", { pool, usage, opencodeGo: [stored] });

    await card("work");
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /OpenCode Go/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenCode Go account" });
    await user.type(within(dialog).getByLabelText("API key"), "sk-go-1234");
    await user.click(within(dialog).getByRole("button", { name: "Add account" }));

    expect(
      await within(dialog).findByText("That key is already in the pool, as go main."),
    ).toBeDefined();
    expect(state.opencodeGo).toEqual([stored]);
  });

  it("signs a locked-out ChatGPT account in again from its card", async () => {
    const { user } = renderApp("/", { pool, usage });

    await user.click(within(await card("spare")).getByRole("button", { name: "Sign in again" }));

    const dialog = await screen.findByRole("dialog", { name: "Add a ChatGPT account" });
    expect(await within(dialog).findByText("WXYZ-2345")).toBeDefined();
  });

  it("offers no sign-in to an OpenCode Go account, which needs a new key", async () => {
    renderApp("/", { pool, usage });

    expect(
      within(await card("go spare")).queryByRole("button", { name: "Sign in again" }),
    ).toBeNull();
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

/** The state via embeds in a signed-in page's shell, and pushes as it changes. */
const viaState = {
  session: true,
  version: "0.0.0",
  pool,
  usage,
  accounts: accounts.map(({ id, label }) => account({ id, label })),
  opencodeGo: opencodeGo.map(({ id, label }) => opencodeGoAccount({ id, label })),
  keys: [{ id: "key-1", name: "laptop", createdAt: fetchedAt, lastUsedAt: fetchedAt }],
  models: [{ id: "gpt-5.5", object: "model", created: 0, owned_by: "openai" }],
  ollama: null,
  openrouter: null,
  fallbacks: [],
  fallbacksError: null,
} as const;

/** `viaState`, with "work" cooling down for a minute. */
const coolingWork = {
  ...viaState,
  pool: {
    ...pool,
    accounts: [
      {
        ...accounts[0],
        state: {
          status: "cooling",
          until: new Date(now + 60_000).toISOString(),
          reason: "usage_limit_reached",
        },
      },
      ...accounts.slice(1),
    ],
  },
} as const;

/** What the callout the "See fallbacks" link sits in says. */
const fallbacksCallout = (link: HTMLElement) => link.closest("[role='note']")?.textContent;

describe("the overview's fallbacks", () => {
  const available = { status: "available" } as const;

  const cooling = {
    status: "cooling",
    until: new Date(now + 60_000).toISOString(),
    reason: "rate_limited",
  } as const;

  const rule = (serving: string | null) => ({
    model: "gpt-5.6-sol",
    fallbacks: ["opencode-go/kimi-k3"],
    status: {
      source: cooling,
      fallbacks: [serving === null ? cooling : available],
      serving,
    },
  });

  it("says which model is falling back to which, with the way to the fallbacks", async () => {
    renderApp("/", { pool, usage, fallbacks: [rule("opencode-go/kimi-k3")] });

    const link = await screen.findByRole("link", { name: "See fallbacks" });

    expect(fallbacksCallout(link)).toContain("gpt-5.6-sol is falling back to kimi-k3.");
    expect(link.getAttribute("href")).toBe("/ui/fallbacks");
  });

  it("says when a model has no fallback left, so its requests fail", async () => {
    renderApp("/", { pool, usage, fallbacks: [rule(null)] });

    expect(fallbacksCallout(await screen.findByRole("link", { name: "See fallbacks" }))).toContain(
      "gpt-5.6-sol has no fallback available, so its requests fail.",
    );
  });

  it("says nothing of fallbacks while each model answers its own requests", async () => {
    renderApp("/", {
      pool,
      usage,
      fallbacks: [
        {
          ...rule("gpt-5.6-sol"),
          status: { source: available, fallbacks: [available], serving: "gpt-5.6-sol" },
        },
      ],
    });

    await card("work");

    expect(screen.queryByRole("link", { name: "See fallbacks" })).toBeNull();
  });
});

describe("the overview, live", () => {
  it("paints the state the shell carries at once, asking via for nothing", async () => {
    embed(viaState);
    const { state } = renderApp("/", { pool, usage });

    const work = await card("work");
    expect(within(work).getByRole("meter", { name: "5 hours" }).getAttribute("aria-valuenow")).toBe(
      "42",
    );
    expect(within(await card("home")).getByText("home@example.com")).toBeDefined();
    // Only what via counted for the providers, which the shell doesn't carry, is asked for.
    expect(state.requests).toEqual(["GET /admin/history/breakdown"]);
    expect(document.getElementById("via-state")).toBeNull();
  });

  it("renders every page from the state the shell carries, asking via for nothing", async () => {
    for (const [path, heading, shown] of [
      ["/accounts", "Accounts", "work@example.com"],
      ["/keys", "Keys", "laptop"],
      ["/models", "Models", "gpt-5.5"],
    ] as const) {
      embed(viaState);
      const { state } = renderApp(path, { pool, usage });

      expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeDefined();
      expect(await screen.findByText(shown)).toBeDefined();
      expect(state.requests).toEqual([]);
      cleanup();
    }
  });

  it("shows what via pushes as it happens, without asking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    embed(viaState);
    const { state } = renderApp("/", { pool, usage });
    const work = await card("work");

    act(() => openSource().push(coolingWork));

    expect(await within(work).findByText("Cooling down")).toBeDefined();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    // What via counted for the providers is asked for once, and not again while the stream is open.
    expect(state.requests).toEqual(["GET /admin/history/breakdown"]);
  });

  it("asks via every few seconds while the stream is down, and stops once it is back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    embed(viaState);
    const { state } = renderApp("/", { pool, usage });
    const work = await card("work");
    act(() => openSource().push(viaState));

    act(() => openSource().fail());
    state.pool = coolingWork.pool;
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(state.requests).toContain("GET /admin/pool");
    expect(await within(work).findByText("Cooling down")).toBeDefined();

    act(() => openSource().push(coolingWork));
    const asked = state.requests.length;
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(state.requests).toHaveLength(asked);
  });

  it("closes the stream when the viewer signs out", async () => {
    embed(viaState);
    const { user } = renderApp("/", { pool, usage });
    await card("work");
    const source = openSource();

    await user.click(await openSignOut(user));
    const dialog = await screen.findByRole("alertdialog", { name: "Sign out of via?" });
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in" });

    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });
});

describe("the overview's usage", () => {
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
      usage: {
        accounts: usage.accounts.slice(0, 1),
        opencodeGo: [],
        openrouter: null,
        refreshing: true,
      },
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
