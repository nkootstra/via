import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OpenrouterModel } from "../src/api/types.ts";
import { renderApp } from "./app.tsx";

const apiKey = "sk-or-v1-abcd";

const catalog: ReadonlyArray<OpenrouterModel> = [
  {
    id: "openai/gpt-6",
    name: "OpenAI: GPT-6",
    inputPerMillion: 2,
    outputPerMillion: 10,
    contextLength: 400_000,
  },
  {
    id: "anthropic/claude-5",
    name: "Anthropic: Claude 5",
    inputPerMillion: 3,
    outputPerMillion: 15,
    contextLength: 200_000,
  },
  {
    id: "google/gemini-4",
    name: "Google: Gemini 4",
    inputPerMillion: null,
    outputPerMillion: null,
    contextLength: null,
  },
];

const saved = { key: "…abcd", models: [], fromConfig: false };

/** The OpenRouter section of the Accounts page. */
const section = async () => screen.findByRole("region", { name: "OpenRouter" });

/** The OpenRouter table's one row. */
const row = async () => {
  const table = await within(await section()).findByRole("table", { name: "OpenRouter" });

  return within(table).getAllByRole("row")[1] ?? table;
};

describe("the OpenRouter section", () => {
  it("adds a key OpenRouter takes, shown only by its last four characters", async () => {
    const { user, state } = renderApp("/accounts", { openrouterKeys: [apiKey] });

    expect(await within(await section()).findByText("No OpenRouter key yet")).toBeDefined();
    await user.click(within(await section()).getByRole("button", { name: "Add OpenRouter key" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenRouter key" });
    await user.type(within(dialog).getByLabelText("API key"), apiKey);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.openrouter).toEqual(saved);
    const added = await row();
    expect(within(added).getByText("…abcd")).toBeDefined();
    expect(within(added).getByText("No models enabled yet")).toBeDefined();
    expect(document.body.textContent).not.toContain(apiKey);
  });

  it("says when OpenRouter refuses a key, in the form, and keeps it open", async () => {
    const { user } = renderApp("/accounts");

    await user.click(within(await section()).getByRole("button", { name: "Add OpenRouter key" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenRouter key" });
    await user.type(within(dialog).getByLabelText("API key"), "sk-wrong");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText(/OpenRouter refused this API key/)).toBeDefined();
  });

  it("enables the models the viewer picks, found by searching", async () => {
    const { user, state } = renderApp("/accounts", {
      openrouter: saved,
      openrouterCatalog: catalog,
    });

    await user.click(within(await row()).getByRole("button", { name: "Actions for OpenRouter" }));
    await user.click(await screen.findByRole("menuitem", { name: "Choose models…" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose OpenRouter models" });
    expect(await within(dialog).findByText("OpenAI: GPT-6")).toBeDefined();
    expect(within(dialog).getByText("$2.00 in · $10.00 out per 1M · 400K context")).toBeDefined();

    await user.type(within(dialog).getByRole("searchbox", { name: "Search models" }), "claude");
    expect(within(dialog).queryByText("OpenAI: GPT-6")).toBeNull();
    await user.click(within(dialog).getByRole("switch", { name: "Anthropic: Claude 5" }));
    await user.clear(within(dialog).getByRole("searchbox", { name: "Search models" }));
    await user.click(within(dialog).getByRole("switch", { name: "OpenAI: GPT-6" }));
    expect(within(dialog).getByText("2 enabled")).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(state.openrouter?.models).toEqual(["anthropic/claude-5", "openai/gpt-6"]),
    );
    expect(await within(await row()).findByText("2 models enabled")).toBeDefined();
  });

  it("removes the key once the viewer confirms", async () => {
    const { user, state } = renderApp("/accounts", { openrouter: saved });

    await user.click(within(await row()).getByRole("button", { name: "Actions for OpenRouter" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove OpenRouter?" });
    await user.click(within(confirm).getByRole("button", { name: "Remove OpenRouter" }));

    expect(await within(await section()).findByText("No OpenRouter key yet")).toBeDefined();
    expect(state.openrouter).toBeNull();
  });

  it("leaves an OpenRouter config.yaml sets up to config.yaml, with every model", async () => {
    renderApp("/accounts", { openrouter: { ...saved, fromConfig: true } });

    const configured = await row();
    expect(within(configured).getByText("Set in config.yaml")).toBeDefined();
    expect(within(configured).getByText("Every model")).toBeDefined();
    expect(within(configured).queryByRole("button", { name: "Actions for OpenRouter" })).toBeNull();
  });
});
