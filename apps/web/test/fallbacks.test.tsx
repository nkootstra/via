import { act, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { Fallback } from "../src/api/types.ts";
import { embed, fakeClock, renderApp, skip } from "./app.tsx";
import { openSource } from "./event-source.ts";

const model = (id: string) => ({ id, object: "model", created: 0, owned_by: "via" });

const models = [
  model("gpt-5.6-sol"),
  model("gpt-5.6-sol-low"),
  model("gpt-5.6-sol-high"),
  model("gpt-5.5"),
  model("gpt-5.5-high"),
  model("opencode-go/kimi-k3"),
  model("openrouter/minimax-m3"),
];

const available = { status: "available" } as const;

/** A rule whose model answers its own requests, every fallback standing by. */
const standingBy = (source: string, fallbacks: ReadonlyArray<string>): Fallback => ({
  model: source,
  fallbacks,
  status: { source: available, fallbacks: fallbacks.map(() => available), serving: source },
});

const now = Date.parse("2026-09-27T12:00:00.000Z");

/** Cooling down for `ms` from `now`, rate limited. */
const cooling = (ms: number) =>
  ({
    status: "cooling",
    until: new Date(now + ms).toISOString(),
    reason: "rate_limited",
  }) as const;

/** A rule whose model cools down for `ms`, so its first fallback answers. */
const fallingBack = (source: string, fallbacks: ReadonlyArray<string>, ms: number): Fallback => ({
  model: source,
  fallbacks,
  status: {
    source: cooling(ms),
    fallbacks: fallbacks.map(() => available),
    serving: fallbacks[0] ?? null,
  },
});

/** The state via puts in a signed-in page's shell, and pushes as it changes, with `fallbacks`. */
const viaState = (fallbacks: ReadonlyArray<Fallback>) =>
  ({
    session: true,
    version: "0.0.0",
    pool: { accounts: [], opencodeGo: [], providers: [] },
    usage: { accounts: [], opencodeGo: [], openrouter: null, refreshing: false },
    accounts: [],
    opencodeGo: [],
    keys: [],
    models,
    ollama: null,
    openrouter: null,
    fallbacks,
  }) as const;

/** The row of the rule for `source`. */
const rowOf = (source: string) => screen.findByRole("article", { name: source });

/** The models a row falls back to, in order, as it names them. */
const chainOf = (row: HTMLElement) =>
  within(within(row).getByRole("list", { name: "Falls back to" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

describe("the fallbacks page", () => {
  it("lists each rule as its model and the models it falls back to, in order", async () => {
    renderApp("/fallbacks", {
      models,
      fallbacks: [standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3", "gpt-5.5"])],
    });

    const row = await rowOf("gpt-5.6-sol");

    expect(chainOf(row)).toEqual(["kimi-k3", "gpt-5.5"]);
  });

  it("says there are no fallbacks yet, and what one does", async () => {
    renderApp("/fallbacks", { models });

    const empty = await screen.findByRole("region", { name: "No fallbacks yet" });

    expect(empty.textContent).toContain(
      "Add one, and when a model is cooling down or out of reach, via answers with another you choose instead of an error.",
    );
  });

  it("announces that the fallbacks are loading", async () => {
    fakeClock();
    renderApp("/fallbacks", { models }, [http.get("*/admin/fallbacks", () => delay("infinite"))]);

    // The router shows it once loading takes a moment, 1 s.
    await skip(1_000);
    expect((await screen.findByRole("status")).textContent).toBe("Loading fallbacks…");
  });

  it("says the fallbacks couldn't be loaded, rather than that there are none", async () => {
    const { user } = renderApp(
      "/fallbacks",
      { models, fallbacks: [standingBy("gpt-5.6-sol", ["gpt-5.5"])] },
      [
        http.get("*/admin/fallbacks", () => new HttpResponse(null, { status: 500 }), {
          once: true,
        }),
      ],
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load fallbacks");
    expect(screen.getByRole("heading", { level: 1, name: "Fallbacks" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "No fallbacks yet" })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await rowOf("gpt-5.6-sol")).toBeDefined();
  });

  it("says a rule whose model answers is standing by", async () => {
    renderApp("/fallbacks", { models, fallbacks: [standingBy("gpt-5.6-sol", ["gpt-5.5"])] });

    expect(within(await rowOf("gpt-5.6-sol")).getByText("Standing by")).toBeDefined();
  });

  it("says a rule is falling back, to which model, why and until when, counting down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    renderApp("/fallbacks", {
      models,
      fallbacks: [fallingBack("gpt-5.6-sol", ["opencode-go/kimi-k3", "gpt-5.5"], 247_000)],
    });

    const row = await rowOf("gpt-5.6-sol");

    const [serving] = within(within(row).getByRole("list", { name: "Falls back to" })).getAllByRole(
      "listitem",
    );

    expect(within(row).getByText("Falling back")).toBeDefined();
    expect(serving?.querySelector("[aria-current='true']")?.textContent).toContain("kimi-k3");
    expect(serving?.textContent).toContain("answering now");
    expect(row.textContent).toContain("Rate limited");
    expect(row.textContent).toContain("Back in 4:07");
    expect(row.textContent).toMatch(/Ends \w+/);

    await act(() => vi.advanceTimersByTimeAsync(3_000));

    expect(row.textContent).toContain("Back in 4:04");
  });

  it("says a model with no account to serve it falls back for that", async () => {
    renderApp("/fallbacks", {
      models,
      fallbacks: [
        {
          ...standingBy("gpt-5.6-sol", ["gpt-5.5"]),
          status: {
            source: { status: "unavailable", reason: "no_accounts" },
            fallbacks: [available],
            serving: "gpt-5.5",
          },
        },
      ],
    });

    expect((await rowOf("gpt-5.6-sol")).textContent).toContain("No account can serve it");
  });

  it("says when no model in a rule's list can answer either", async () => {
    renderApp("/fallbacks", {
      models,
      fallbacks: [
        {
          ...fallingBack("gpt-5.6-sol", ["gpt-5.5"], 60_000),
          status: { source: cooling(60_000), fallbacks: [cooling(60_000)], serving: null },
        },
      ],
    });

    const row = await rowOf("gpt-5.6-sol");
    expect(within(row).getByText("No fallback available")).toBeDefined();
    expect(row.textContent).toContain(
      "Every model in the list is unavailable too, so requests fail.",
    );
    expect(row.textContent).toContain("Rate limited");
  });

  it("renders the rules the shell carries, asking via for nothing", async () => {
    embed(viaState([standingBy("gpt-5.6-sol", ["gpt-5.5"])]));
    const { state } = renderApp("/fallbacks", { models });

    expect(chainOf(await rowOf("gpt-5.6-sol"))).toEqual(["gpt-5.5"]);
    expect(state.requests).toEqual([]);
  });

  it("announces when a rule starts or stops falling back, and nothing else", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    embed(viaState([standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3"])]));
    renderApp("/fallbacks", { models });
    await rowOf("gpt-5.6-sol");
    const status = screen.getByRole("status");

    expect(status.textContent).toBe("");

    act(() =>
      openSource().push(viaState([fallingBack("gpt-5.6-sol", ["opencode-go/kimi-k3"], 60_000)])),
    );
    await waitFor(() => expect(status.textContent).toBe("gpt-5.6-sol is falling back to kimi-k3."));

    // The countdown ticks, which is no news.
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(status.textContent).toBe("gpt-5.6-sol is falling back to kimi-k3.");

    act(() => openSource().push(viaState([standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3"])])));
    await waitFor(() => expect(status.textContent).toBe("gpt-5.6-sol is answering again."));
  });

  it("announces when no model in a rule's list can answer", async () => {
    embed(viaState([standingBy("gpt-5.6-sol", ["gpt-5.5"])]));
    renderApp("/fallbacks", { models });
    await rowOf("gpt-5.6-sol");

    act(() =>
      openSource().push(
        viaState([
          {
            ...standingBy("gpt-5.6-sol", ["gpt-5.5"]),
            status: { source: cooling(60_000), fallbacks: [cooling(60_000)], serving: null },
          },
        ]),
      ),
    );

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "gpt-5.6-sol has no fallback available, so its requests fail.",
      ),
    );
  });

  it("is in the navigation, after Models", async () => {
    renderApp("/fallbacks", { models });

    const nav = within(await screen.findByRole("navigation", { name: "Pages" }));
    const links = nav.getAllByRole("link");
    const modelsAt = links.indexOf(nav.getByRole("link", { name: "Models" }));

    expect(links[modelsAt + 1]).toBe(nav.getByRole("link", { name: "Fallbacks" }));
  });
});
