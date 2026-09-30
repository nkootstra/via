import { act, screen, waitFor, within } from "@testing-library/react";
import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageRequest } from "../src/api/types.ts";
import { breakdown, cost, group } from "../src/testing/history.ts";
import { renderApp } from "./app.tsx";
import { openSource } from "./event-source.ts";

const HOUR = 3_600_000;

const now = new Date("2026-09-27T12:30:00.000Z");

const byModel = breakdown([
  group({ group: "gpt-6-astra", requests: 30, errors: 3, inputTokens: 3_000, cachedTokens: 1_500 }),
  group({ group: "opencode-go/kimi-k3", requests: 10, cost: cost(0.25) }),
]);

const byAccount = breakdown([
  group({ group: "acc-1", label: "work@example.com", requests: 25 }),
  group({ group: "provider:openrouter", label: "openrouter", requests: 15 }),
  // Refused before any account served it, so it has only the provider's name.
  group({ group: "provider:codex", label: "codex", requests: 2 }),
]);

const request = (
  fields: Partial<UsageRequest> & Pick<UsageRequest, "requestId">,
): UsageRequest => ({
  at: now.getTime() - HOUR,
  status: 200,
  error: Option.none(),
  errorMessage: Option.none(),
  streamEnd: Option.some("completed"),
  keyId: Option.some("key-1"),
  keyName: Option.some("laptop"),
  model: "gpt-6-astra",
  provider: "codex",
  accountId: Option.some("acc-1"),
  accountLabel: Option.some("work@example.com"),
  inputTokens: Option.some(1_200),
  cachedTokens: Option.some(800),
  outputTokens: Option.some(300),
  reasoningTokens: Option.none(),
  costUsd: Option.none(),
  durationMs: 2_400,
  firstChunkMs: Option.some(600),
  ...fields,
});

const seed = {
  historySeries: {
    points: [
      {
        bucket: now.getTime() - 2 * HOUR,
        group: "gpt-6-astra",
        requests: 30,
        measured: 30,
        inputTokens: 3_000,
        cachedTokens: 1_500,
        outputTokens: 600,
        reasoningTokens: 0,
      },
    ],
  },
  historyBreakdown: new Map([
    ["model", byModel],
    ["account", byAccount],
  ]),
  historyRequests: [
    request({ requestId: "r1" }),
    request({
      requestId: "r2",
      model: "opencode-go/kimi-k3",
      status: 429,
      error: Option.some("rate_limit_exceeded"),
      errorMessage: Option.some("Every account is cooling down"),
      inputTokens: Option.none(),
      outputTokens: Option.none(),
      cachedTokens: Option.none(),
      accountId: Option.none(),
      accountLabel: Option.none(),
    }),
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
});

afterEach(() => vi.useRealTimers());

/** The figure a stat names, and the line under it. */
const stat = (label: string) => {
  const figure = screen
    .getAllByRole("term")
    .find((term) => term.textContent === label)?.nextElementSibling;

  const detail = figure?.querySelector("span")?.textContent ?? "";
  const all = figure?.textContent ?? "";

  return { value: all.slice(0, all.length - detail.length), detail };
};

/** The last history query the page sent with the `has` param, as its search params. */
const lastQuery = (
  state: { readonly historyQueries: ReadonlyArray<URLSearchParams> },
  has: string,
) => state.historyQueries.filter((query) => query.has(has)).at(-1);

describe("the usage page", () => {
  it("is in the navigation", async () => {
    renderApp("/usage", seed);

    const link = await screen.findByRole("link", { name: "Usage" });
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("totals the last 24 hours: requests, tokens, cache hits, cost and latency", async () => {
    renderApp("/usage", seed);

    await screen.findByRole("heading", { level: 1, name: "Usage" });
    await screen.findByRole("figure", { name: "Tokens per hour" });

    expect(stat("Requests")).toEqual({ value: "40", detail: "3 failed" });
    expect(stat("Tokens")).toEqual({ value: "4.4K", detail: "4K in · 400 out" });
    expect(stat("Cache hit rate")).toEqual({ value: "48%", detail: "of input tokens" });
    expect(stat("API-equivalent cost")).toEqual({ value: "$0.75", detail: "At API prices" });
    expect(stat("Time to first token")).toEqual({ value: "1.2 s", detail: "p95 · median 400 ms" });
  });

  it("breaks usage down by model, then by account", async () => {
    const { user } = renderApp("/usage", seed);

    const table = await screen.findByRole("table", { name: "Usage by model" });
    const rows = within(table).getAllByRole("row").slice(1);
    // Named as the Models page names them: without the provider's prefix, after its logo.
    expect(rows.map((row) => row.querySelector("td")?.textContent)).toEqual([
      "gpt-6-astra",
      "kimi-k3",
    ]);
    expect(within(rows[0] ?? table).getByRole("img", { name: "Codex" })).toBeDefined();
    expect(within(rows[1] ?? table).getByRole("img", { name: "OpenCode Go" })).toBeDefined();
    expect(within(rows[1] ?? table).getByTitle("opencode-go/kimi-k3")).toBeDefined();

    await user.click(screen.getByRole("radio", { name: "Account" }));

    const accounts = await screen.findByRole("table", { name: "Usage by account" });
    expect(
      within(accounts)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("td")?.textContent),
    ).toEqual(["work@example.com", "OpenRouter", "Not served (Codex)"]);
  });

  it("tells apart a model two providers serve by naming the provider in the legend", async () => {
    const both = breakdown([
      group({ group: "gpt-6-luna" }),
      group({ group: "opencode-go/gpt-6-luna" }),
      group({ group: "opencode-go/kimi-k3" }),
    ]);

    renderApp("/usage", { ...seed, historyBreakdown: new Map([["model", both]]) });

    const legend = await screen.findByRole("list", { name: "Series" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["gpt-6-luna · Codex", "gpt-6-luna · OpenCode Go", "kimi-k3"]);
  });

  it("asks for days in the viewer's time zone over a longer range", async () => {
    const { state, user } = renderApp("/usage", seed);

    await screen.findByRole("figure", { name: "Tokens per hour" });
    await user.click(screen.getByRole("radio", { name: "30 days" }));
    await screen.findByRole("figure", { name: "Tokens per day" });

    const series = state.historyQueries.filter((query) => query.has("bucket")).at(-1);
    expect(series?.get("bucket")).toBe("day");
    expect(series?.get("tzOffsetMinutes")).toBe(String(-now.getTimezoneOffset()));
    expect(Number(series?.get("to")) - Number(series?.get("from"))).toBe(30 * 24 * HOUR);
  });

  it("lists the requests, newest first, with why one failed", async () => {
    renderApp("/usage", seed);

    const log = await screen.findByRole("table", { name: "Requests" });
    const rows = within(log).getAllByRole("row").slice(1);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("gpt-6-astra");
    expect(rows[0]?.textContent).toContain("laptop");
    expect(
      within(rows[1] ?? log)
        .getByText("Rate limited")
        .getAttribute("title"),
    ).toBe("rate_limit_exceeded");
  });

  it("says why a request failed, in the upstream's or via's own words", async () => {
    renderApp("/usage", {
      ...seed,
      historyRequests: [
        request({
          requestId: "refused",
          model: "opencode-go/grok-4.7",
          status: 400,
          error: Option.some("ModelProtocolUnsupported"),
          errorMessage: Option.some("Model does not support this protocol."),
        }),
      ],
    });

    const log = await screen.findByRole("table", { name: "Requests" });
    const [row] = within(log).getAllByRole("row").slice(1);

    expect(row?.textContent).toContain("ModelProtocolUnsupported");
    expect(row?.textContent).toContain("Model does not support this protocol.");
  });

  it("narrows the whole page to a row picked in the breakdown, and keeps it in the URL", async () => {
    const { state, router, user } = renderApp("/usage", seed);

    const table = await screen.findByRole("table", { name: "Usage by model" });
    await user.click(within(table).getByRole("button", { name: "Filter by kimi-k3" }));

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ model: "opencode-go/kimi-k3" }),
    );

    await waitFor(() =>
      expect(
        state.historyQueries.filter((query) => query.get("model") === "opencode-go/kimi-k3").length,
      ).toBeGreaterThanOrEqual(3),
    );

    expect(screen.getByRole("combobox", { name: "Model: kimi-k3" })).toBeDefined();
    expect(
      within(screen.getByRole("table", { name: "Requests" })).getAllByRole("row"),
    ).toHaveLength(2);
  });

  it("reads its filters from the URL, so they survive a reload", async () => {
    const { state } = renderApp(
      "/usage?range=7d&by=account&model=opencode-go/kimi-k3&failed=true",
      seed,
    );

    expect(await screen.findByRole("combobox", { name: "Model: kimi-k3" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Week" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Account" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("switch", { name: "Failed only" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    await waitFor(() => {
      const asked = lastQuery(state, "groupBy");
      expect(asked?.get("model")).toBe("opencode-go/kimi-k3");
      expect(asked?.get("outcome")).toBe("error");
    });
  });

  it("filters by a model chosen in its facet, searching by name", async () => {
    const { router, user } = renderApp("/usage", seed);

    await user.click(await screen.findByRole("combobox", { name: "Model" }));
    await user.keyboard("kimi");
    await user.click(await screen.findByRole("option", { name: /kimi-k3/ }));

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ model: "opencode-go/kimi-k3" }),
    );
  });

  it("toggles failed requests only from the words beside the switch too", async () => {
    const { router, user } = renderApp("/usage", seed);

    await user.click(await screen.findByText("Failed only"));

    await waitFor(() => expect(router.state.location.search).toEqual({ failed: true }));
  });

  it("clears every filter at once", async () => {
    const { router, user } = renderApp("/usage?model=opencode-go/kimi-k3&failed=true", seed);

    await user.click(await screen.findByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDefined();
    expect(screen.getByRole("switch", { name: "Failed only" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("says when nothing matches the filters, and offers to clear them", async () => {
    const { router, user } = renderApp("/usage?failed=true", {
      ...seed,
      historyBreakdown: new Map(),
    });

    expect(
      await screen.findByRole("heading", { name: "No requests match these filters" }),
    ).toBeDefined();

    // The empty state's own, after the filter bar's.
    await user.click(
      screen.getAllByRole("button", { name: "Clear filters" }).at(-1) ?? document.body,
    );

    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("loads more requests on request", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      request({ requestId: `r${i}`, at: now.getTime() - i * 1_000 }),
    );

    const { user } = renderApp("/usage", { ...seed, historyRequests: many });

    const log = await screen.findByRole("table", { name: "Requests" });
    expect(within(log).getAllByRole("row")).toHaveLength(51);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(log).getAllByRole("row")).toHaveLength(61));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says the token totals leave out requests that reported none", async () => {
    // 7 answered with usage, 1 answered without, and 2 failed, which have none to report.
    const partial = breakdown([
      group({ group: "gpt-6-astra", requests: 10, errors: 2, measured: 7, unmeasured: 1 }),
    ]);

    renderApp("/usage", { ...seed, historyBreakdown: new Map([["model", partial]]) });

    await screen.findByRole("heading", { level: 1, name: "Usage" });

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("note")
          .some((note) => note.textContent?.includes("1 request reported no token usage")),
      ).toBe(true),
    );
  });

  it("names the models it couldn't price, rather than counting them free", async () => {
    const unpriced = breakdown([
      group({ group: "local/llama", cost: cost(0, 0, ["local/llama"]) }),
    ]);

    renderApp("/usage", {
      ...seed,
      historyBreakdown: new Map([
        [
          "model",
          { ...unpriced, totals: { ...unpriced.totals, cost: cost(0, 0, ["local/llama"]) } },
        ],
      ]),
    });

    await screen.findByRole("heading", { level: 1, name: "Usage" });
    await waitFor(() =>
      expect(stat("API-equivalent cost")).toEqual({
        value: "$0.00",
        detail: "Leaves out local/llama: no price known",
      }),
    );
  });

  it("says so when the range has no requests", async () => {
    renderApp("/usage");

    expect(
      await screen.findByRole("heading", { name: "No requests in the last day" }),
    ).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("the usage page, live", () => {
  it("fetches the usage again as soon as via says it changed", async () => {
    const { state } = renderApp("/usage", seed);
    await screen.findByRole("table", { name: "Requests" });
    const asked = state.historyQueries.length;

    act(() => openSource().history());

    await waitFor(() => expect(state.historyQueries.length).toBeGreaterThan(asked));
  });

  it("asks nothing on a timer while via pushes, and every 15 s once the stream drops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    const { state } = renderApp("/usage", seed);
    await screen.findByRole("table", { name: "Requests" });
    act(() => openSource().history());
    await waitFor(() => expect(state.historyQueries.length).toBeGreaterThan(0));
    const settled = state.historyQueries.length;

    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(state.historyQueries).toHaveLength(settled);

    act(() => openSource().fail());
    await act(() => vi.advanceTimersByTimeAsync(16_000));
    expect(state.historyQueries.length).toBeGreaterThan(settled);
  });
});
