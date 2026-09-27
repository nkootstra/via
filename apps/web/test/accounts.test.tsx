import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { account, opencodeGoAccount } from "../src/testing/admin-handlers.ts";
import { renderApp } from "./app.tsx";

const work = account({ id: "acc-1", label: "work", email: "me@work.example" });

const home = account({ id: "acc-2", label: "home", plan: "pro" });

const rowOf = async (label: string, name = "Accounts") => {
  const table = await screen.findByRole("table", { name });

  const row = within(table)
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(label) !== null);

  if (row === undefined) throw new Error(`No row for ${label}`);

  return row;
};

describe("the accounts page", () => {
  it("lists each account with its email, plan and whether it's enabled", async () => {
    renderApp("/accounts", { accounts: [work, home] });

    const row = await rowOf("work");
    expect(within(row).getByText("me@work.example")).toBeDefined();
    expect(within(row).getByText("plus")).toBeDefined();
    expect(
      within(row).getByRole("switch", { name: "work enabled" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("renames an account", async () => {
    const { state, user } = renderApp("/accounts", { accounts: [work] });

    await user.click(within(await rowOf("work")).getByRole("button", { name: "Actions for work" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename work" });
    const input = within(dialog).getByLabelText("Label");
    await user.clear(input);
    await user.type(input, "office");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("office")).toBeDefined();
    expect(state.accounts[0]?.label).toBe("office");
  });

  it("disables and enables an account from its switch", async () => {
    const { state, user } = renderApp("/accounts", { accounts: [work] });
    const toggle = within(await rowOf("work")).getByRole("switch", { name: "work enabled" });

    await user.click(toggle);
    await waitFor(() => expect(state.accounts[0]?.enabled).toBe(false));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

    await user.click(toggle);
    await waitFor(() => expect(state.accounts[0]?.enabled).toBe(true));
  });

  it("removes an account once the viewer confirms", async () => {
    const { state, user } = renderApp("/accounts", { accounts: [work, home] });

    await user.click(within(await rowOf("home")).getByRole("button", { name: "Actions for home" }));
    const item = await screen.findByRole("menuitem", { name: "Remove…" });
    expect(item.hasAttribute("data-destructive")).toBe(true);
    expect(item.querySelector("svg")).not.toBeNull();
    await user.click(item);
    const confirm = await screen.findByRole("alertdialog", { name: "Remove home?" });
    const remove = within(confirm).getByRole("button", { name: "Remove account" });
    expect(remove.getAttribute("data-variant")).toBe("destructive");
    await user.click(remove);

    await waitFor(() => expect(screen.queryByText("home")).toBeNull());
    expect(state.accounts.map((a) => a.id)).toEqual(["acc-1"]);
  });

  it("offers to add the first account when there are none", async () => {
    renderApp("/accounts");

    const empty = await screen.findByRole("region", { name: "No accounts yet" });
    expect(within(empty).getByRole("button", { name: "Add account" })).toBeDefined();
  });
});

describe("adding an account", () => {
  it("shows the code to enter, polls until the account is added, then says so", async () => {
    const added = account({ id: "acc-9", label: "new" });

    const { user } = renderApp("/accounts", {
      nextLogin: [{ status: "pending" }, { status: "added", account: added }],
    });

    await user.click(
      within(await screen.findByRole("region", { name: "No accounts yet" })).getByRole("button", {
        name: "Add account",
      }),
    );
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));

    const dialog = await screen.findByRole("dialog", { name: "Add a ChatGPT account" });
    expect(await within(dialog).findByText("WXYZ-2345")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Copy Your code" })).toBeDefined();

    expect(
      within(dialog).getByRole("link", { name: "Open sign-in page" }).getAttribute("href"),
    ).toBe("https://auth.openai.com/codex/device");

    // The first poll says pending; the next, 2 s later, says added.
    expect(
      await screen.findByRole("dialog", { name: "Account added" }, { timeout: 4_000 }),
    ).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add a ChatGPT account" })).toBeNull(),
    );
    expect(await rowOf("new")).toBeDefined();
  });

  it("says why when the login fails", async () => {
    const { user } = renderApp("/accounts", {
      accounts: [work],
      nextLogin: [{ status: "failed", error: "The code expired" }],
    });

    await rowOf("work");
    await user.click(screen.getAllByRole("button", { name: "Add account" })[0] ?? document.body);
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));

    const dialog = await screen.findByRole("dialog", { name: "Add a ChatGPT account" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("The code expired");
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeDefined();
  });
});

const main = opencodeGoAccount({ id: "go-1", label: "go main", key: "…1234" });

const imported = opencodeGoAccount({
  id: "go-2",
  label: "OpenCode Go (imported)",
  key: "…9999",
  environmentVariable: "OPENCODE_API_KEY",
});

const goRow = (label: string) => rowOf(label, "OpenCode Go keys");

describe("the accounts page's OpenCode Go keys", () => {
  it("lists them apart from the ChatGPT accounts, each key masked", async () => {
    renderApp("/accounts", { accounts: [work], opencodeGo: [main] });

    const codex = await screen.findByRole("region", { name: "Codex" });
    expect(await within(codex).findByText("work")).toBeDefined();
    const go = await screen.findByRole("region", { name: "OpenCode Go" });
    const row = await goRow("go main");
    expect(go.contains(row)).toBe(true);
    expect(within(row).getByText("…1234")).toBeDefined();
    expect(
      within(row).getByRole("switch", { name: "go main enabled" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("notes the key imported from the deprecated variable while it is still set", async () => {
    renderApp("/accounts", { opencodeGo: [main, imported] });

    expect(
      within(await goRow("OpenCode Go (imported)")).getByText(/OPENCODE_API_KEY/),
    ).toBeDefined();
    expect(within(await goRow("go main")).queryByText(/deprecated/)).toBeNull();
  });

  it("renames, disables and removes a key, once the viewer confirms", async () => {
    const { state, user } = renderApp("/accounts", { opencodeGo: [main] });

    await user.click(
      within(await goRow("go main")).getByRole("button", { name: "Actions for go main" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const rename = await screen.findByRole("dialog", { name: "Rename go main" });
    const input = within(rename).getByLabelText("Label");
    await user.clear(input);
    await user.type(input, "go work");
    await user.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.opencodeGo[0]?.label).toBe("go work"));

    await user.click(
      within(await goRow("go work")).getByRole("switch", { name: "go work enabled" }),
    );
    await waitFor(() => expect(state.opencodeGo[0]?.enabled).toBe(false));

    await user.click(
      within(await goRow("go work")).getByRole("button", { name: "Actions for go work" }),
    );
    const item = await screen.findByRole("menuitem", { name: "Remove…" });
    expect(item.hasAttribute("data-destructive")).toBe(true);
    expect(item.querySelector("svg")).not.toBeNull();
    await user.click(item);
    const confirm = await screen.findByRole("alertdialog", { name: "Remove go work?" });
    const remove = within(confirm).getByRole("button", { name: "Remove key" });
    expect(remove.getAttribute("data-variant")).toBe("destructive");
    expect(remove.querySelector("svg")).not.toBeNull();
    await user.click(remove);

    await waitFor(() => expect(state.opencodeGo).toEqual([]));
    expect(await screen.findByRole("region", { name: "No OpenCode Go keys yet" })).toBeDefined();
  });
});
