import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "./app.tsx";

const models = [
  { id: "gpt-5.5", object: "model", created: 0, owned_by: "openai" },
  { id: "gpt-5.5-mini", object: "model", created: 0, owned_by: "openai" },
  // As via serves a provider's model: its id prefixed with the provider's name, while
  // `owned_by` is whatever the provider says.
  {
    id: "opencode-go/kimi-k2",
    object: "model",
    created: 0,
    owned_by: "opencode",
    context_length: 262_144,
  },
];

describe("the models page", () => {
  it("groups the models by who serves them, Codex first", async () => {
    renderApp("/models", { models });

    const codex = await screen.findByRole("region", { name: "Codex" });
    expect(within(codex).getByText("gpt-5.5")).toBeDefined();
    expect(within(codex).getByText("gpt-5.5-mini")).toBeDefined();

    const provider = screen.getByRole("region", { name: "opencode-go" });
    expect(within(provider).getByText("opencode-go/kimi-k2")).toBeDefined();
    expect(within(provider).getByText("262k context")).toBeDefined();

    const regions = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));

    expect(regions.indexOf("Codex")).toBeLessThan(regions.indexOf("opencode-go"));
  });

  it("filters by search", async () => {
    const { user } = renderApp("/models", { models });

    await user.type(await screen.findByRole("searchbox", { name: "Search models" }), "mini");

    expect(await screen.findByText("gpt-5.5-mini")).toBeDefined();
    expect(screen.queryByText("kimi-k2")).toBeNull();
    expect(screen.queryByRole("region", { name: "opencode-go" })).toBeNull();

    await user.clear(screen.getByRole("searchbox", { name: "Search models" }));
    await user.type(screen.getByRole("searchbox", { name: "Search models" }), "nothing");
    expect((await screen.findByRole("status")).textContent).toContain("No model matches");
  });
});
