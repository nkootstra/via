import { screen, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Fallback } from "../src/api/types.ts";
import { fakeClock, renderApp, skip } from "./app.tsx";

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

  it("is in the navigation, after Models", async () => {
    renderApp("/fallbacks", { models });

    const nav = within(await screen.findByRole("navigation", { name: "Pages" }));
    const links = nav.getAllByRole("link");
    const modelsAt = links.indexOf(nav.getByRole("link", { name: "Models" }));

    expect(links[modelsAt + 1]).toBe(nav.getByRole("link", { name: "Fallbacks" }));
  });
});
