import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Fallback } from "../src/api/types.ts";
import { renderApp } from "./app.tsx";

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

  it("is in the navigation, after Models", async () => {
    renderApp("/fallbacks", { models });

    const nav = within(await screen.findByRole("navigation", { name: "Pages" }));
    const links = nav.getAllByRole("link");
    const modelsAt = links.indexOf(nav.getByRole("link", { name: "Models" }));

    expect(links[modelsAt + 1]).toBe(nav.getByRole("link", { name: "Fallbacks" }));
  });
});
