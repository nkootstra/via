import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { account } from "../src/testing/admin-handlers.ts";
import { renderApp } from "./app.tsx";

const work = account({ id: "acc-1", label: "work", email: "me@work.example" });

const home = account({ id: "acc-2", label: "home", plan: "pro" });

const rowOf = async (label: string) => {
  const table = await screen.findByRole("table", { name: "Accounts" });

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
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove home?" });
    await user.click(within(confirm).getByRole("button", { name: "Remove account" }));

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

    await user.click(await screen.findByRole("button", { name: "Add account" }));

    const dialog = await screen.findByRole("dialog", { name: "Add a ChatGPT account" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("The code expired");
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeDefined();
  });
});
