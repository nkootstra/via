import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "./app.tsx";

const nas = "http://192.168.1.20:11434";

const found = { version: "0.35.0", models: ["nimble", "llama3.2"] };

/** The Ollama section of the Accounts page. */
const section = async () => screen.findByRole("region", { name: "Ollama" });

/** The Ollama table's one row. */
const row = async () => {
  const table = await within(await section()).findByRole("table", { name: "Ollama" });

  return within(table).getAllByRole("row")[1] ?? table;
};

describe("the Ollama section", () => {
  it("invites the viewer to add Ollama when via knows none", async () => {
    renderApp("/accounts");

    expect(await within(await section()).findByText("No Ollama yet")).toBeDefined();
  });

  it("adds Ollama by its address, and shows its version and models", async () => {
    const { user, state } = renderApp("/accounts", { ollamaAt: new Map([[nas, found]]) });

    await user.click(within(await section()).getByRole("button", { name: "Add Ollama" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Ollama" });
    const address = within(dialog).getByRole("textbox", { name: "Address" });
    await user.clear(address);
    await user.type(address, nas);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.ollama).toEqual({ address: nas, fromConfig: false });
    const saved = await row();
    expect(within(saved).getByText(nas)).toBeDefined();
    expect(await within(saved).findByText("Ollama 0.35.0")).toBeDefined();
    expect(within(saved).getByText("nimble, llama3.2")).toBeDefined();
  });

  it("offers Ollama's usual address, as on the machine via runs on", async () => {
    const { user } = renderApp("/accounts");

    await user.click(within(await section()).getByRole("button", { name: "Add Ollama" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Ollama" });

    expect(within(dialog).getByRole("textbox", { name: "Address" })).toHaveProperty(
      "value",
      "http://localhost:11434",
    );
    expect(dialog.textContent).toContain("http://host.docker.internal:11434");
  });

  it("says why an address isn't one, in the form, and keeps it open", async () => {
    const { user } = renderApp("/accounts");

    await user.click(within(await section()).getByRole("button", { name: "Add Ollama" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Ollama" });
    const address = within(dialog).getByRole("textbox", { name: "Address" });
    await user.clear(address);
    await user.type(address, "ftp://nas");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText(/isn't an address/)).toBeDefined();
  });

  it("says why a saved Ollama can't be reached, and checks again when asked", async () => {
    const { user, state } = renderApp("/accounts", {
      ollama: { address: nas, fromConfig: false },
    });

    expect(
      await within(await row()).findByText("Can't reach it: nothing answered there"),
    ).toBeDefined();

    state.ollamaAt = new Map([[nas, found]]);
    await user.click(within(await row()).getByRole("button", { name: "Actions for Ollama" }));
    await user.click(await screen.findByRole("menuitem", { name: "Check again" }));

    expect(await within(await row()).findByText("Ollama 0.35.0")).toBeDefined();
  });

  it("changes a saved Ollama's address", async () => {
    const other = "http://nas.local:11434";

    const { user, state } = renderApp("/accounts", {
      ollama: { address: nas, fromConfig: false },
      ollamaAt: new Map([[other, found]]),
    });

    await user.click(within(await row()).getByRole("button", { name: "Actions for Ollama" }));
    await user.click(await screen.findByRole("menuitem", { name: "Change address…" }));
    const dialog = await screen.findByRole("dialog", { name: "Change Ollama's address" });
    const address = within(dialog).getByRole("textbox", { name: "Address" });
    expect(address).toHaveProperty("value", nas);
    await user.clear(address);
    await user.type(address, other);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(state.ollama?.address).toBe(other));
    expect(await within(await row()).findByText("Ollama 0.35.0")).toBeDefined();
  });

  it("removes a saved Ollama once the viewer confirms", async () => {
    const { user, state } = renderApp("/accounts", {
      ollama: { address: nas, fromConfig: false },
    });

    await user.click(within(await row()).getByRole("button", { name: "Actions for Ollama" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Ollama?" });
    await user.click(within(confirm).getByRole("button", { name: "Remove Ollama" }));

    expect(await within(await section()).findByText("No Ollama yet")).toBeDefined();
    expect(state.ollama).toBeNull();
  });

  it("leaves an Ollama config.yaml sets up to config.yaml", async () => {
    const { user } = renderApp("/accounts", {
      ollama: { address: nas, fromConfig: true },
      ollamaAt: new Map([[nas, found]]),
    });

    const saved = await row();
    expect(within(saved).getByText("Set in config.yaml")).toBeDefined();
    await user.click(within(saved).getByRole("button", { name: "Actions for Ollama" }));
    expect(await screen.findByRole("menuitem", { name: "Check again" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Change address…" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Remove…" })).toBeNull();
  });
});
