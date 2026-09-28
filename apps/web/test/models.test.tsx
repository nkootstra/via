import { screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
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

    const provider = screen.getByRole("region", { name: "OpenCode Go" });
    expect(within(provider).getByText("opencode-go/kimi-k2")).toBeDefined();
    expect(within(provider).getByText("262K context")).toBeDefined();

    const groups = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);

    expect(groups).toEqual(["Codex", "OpenCode Go"]);
  });

  it("filters by search", async () => {
    const { user } = renderApp("/models", { models });

    await user.type(await screen.findByRole("searchbox", { name: "Search models" }), "mini");

    expect(await screen.findByText("gpt-5.5-mini")).toBeDefined();
    expect(screen.queryByText("kimi-k2")).toBeNull();
    expect(screen.queryByRole("region", { name: "OpenCode Go" })).toBeNull();

    await user.clear(screen.getByRole("searchbox", { name: "Search models" }));
    await user.type(screen.getByRole("searchbox", { name: "Search models" }), "nothing");
    expect((await screen.findByRole("status")).textContent).toContain("No model matches");
  });

  it("clears a search that found nothing, back in the field", async () => {
    const { user } = renderApp("/models", { models });

    const search = await screen.findByRole("searchbox", { name: "Search models" });
    await user.type(search, "nothing");
    await user.click(await screen.findByRole("button", { name: "Clear search" }));

    expect(search).toHaveProperty("value", "");
    expect(document.activeElement).toBe(search);
    expect(await screen.findByRole("region", { name: "Codex" })).toBeDefined();
  });

  it("lists a provider's models as a list, keeping a cut-short id whole on hover", async () => {
    renderApp("/models", { models });

    const codex = await screen.findByRole("region", { name: "Codex" });
    const items = within(within(codex).getByRole("list")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["gpt-5.5", "gpt-5.5-mini"]);
    expect(within(codex).getByText("gpt-5.5-mini").getAttribute("title")).toBe("gpt-5.5-mini");
  });

  it("announces how many models match as the search changes", async () => {
    const { user } = renderApp("/models", { models });

    const search = await screen.findByRole("searchbox", { name: "Search models" });
    expect(screen.getByRole("status").textContent).toBe("");

    await user.type(search, "gpt");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2 matches"));

    await user.type(search, "-5.5-mini");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 match"));
  });

  it("says the models couldn't be loaded, rather than that there are none", async () => {
    const { user } = renderApp("/models", { models }, [
      http.get("*/admin/models", () => new HttpResponse(null, { status: 500 }), { once: true }),
    ]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load models");
    expect(screen.getByRole("heading", { level: 1, name: "Models" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "No models to list" })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("region", { name: "Codex" })).toBeDefined();
  });

  it("titles an empty list as a section of the page", async () => {
    renderApp("/models", { models: [] });

    expect(
      await screen.findByRole("heading", { level: 2, name: "No models to list" }),
    ).toBeDefined();
  });

  it("announces that the models are loading", async () => {
    renderApp("/models", { models }, [http.get("*/admin/models", () => delay("infinite"))]);

    expect((await screen.findByRole("status")).textContent).toBe("Loading models…");
  });
});
