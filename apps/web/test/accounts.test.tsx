import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@via/ui";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { useAddAccount } from "../src/components/add-account.tsx";
import {
  account,
  adminHandlers,
  createAdminState,
  opencodeGoAccount,
} from "../src/testing/admin-handlers.ts";
import { fakeClock, renderApp, server, skip } from "./app.tsx";
import { openSource } from "./event-source.ts";

const work = account({ id: "acc-1", label: "work", email: "me@work.example" });

const home = account({ id: "acc-2", label: "home", plan: "pro" });

const main = opencodeGoAccount({ id: "go-1", label: "go main", key: "…1234" });

const rowOf = async (label: string, name = "ChatGPT accounts") => {
  const table = await screen.findByRole("table", { name });

  const row = within(table)
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(label) !== null);

  if (row === undefined) throw new Error(`No row for ${label}`);

  return row;
};

/** An error toast, as it's announced: Base UI reads it out through an alert. */
const errorToast = (title: string) =>
  waitFor(() =>
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.startsWith(title))).toBe(
      true,
    ),
  );

/** A button that opens the add-account dialog at the ChatGPT sign-in, as a locked-out card will. */
function SignInAgain() {
  const add = useAddAccount();

  return (
    <>
      <button type="button" onClick={add.openCodex}>
        Sign in again
      </button>
      {add.dialog}
    </>
  );
}

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

  it("gives every action in an account's menu an icon, so their labels line up", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] });

    await user.click(within(await rowOf("work")).getByRole("button", { name: "Actions for work" }));

    for (const name of ["Rename…", "Remove…"]) {
      expect((await screen.findByRole("menuitem", { name })).querySelector("svg")).not.toBeNull();
    }
  });

  it("renames an account", async () => {
    const { state, user } = renderApp("/accounts", { accounts: [work] });

    await user.click(within(await rowOf("work")).getByRole("button", { name: "Actions for work" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename work" });
    const input = within(dialog).getByLabelText("Label");
    await user.clear(input);
    await user.type(input, "office");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    // By name: the "Account renamed" toast is a dialog too.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename work" })).toBeNull());
    expect(await screen.findByText("office")).toBeDefined();
    expect(state.accounts[0]?.label).toBe("office");
  });

  it("puts each account's actions in its row's last cell", async () => {
    renderApp("/accounts", { accounts: [work], opencodeGo: [main] });

    for (const [label, table] of [
      ["work", "ChatGPT accounts"],
      ["go main", "OpenCode Go accounts"],
    ] as const) {
      const last = within(await rowOf(label, table))
        .getAllByRole("cell")
        .at(-1);

      expect(last?.contains(screen.getByRole("button", { name: `Actions for ${label}` }))).toBe(
        true,
      );
    }
  });

  it("cuts a long label short, keeping all of it on hover", async () => {
    const long = "a label far too long to fit in its column without being cut short";
    renderApp("/accounts", { accounts: [{ ...work, label: long }] });

    const label = within(await rowOf(long)).getByText(long);
    expect(label.getAttribute("title")).toBe(long);
    expect(
      within(await rowOf(long))
        .getByText("me@work.example")
        .getAttribute("title"),
    ).toBe("me@work.example");
  });

  it("asks for a label rather than renaming to nothing", async () => {
    const { state, user } = renderApp("/accounts", { accounts: [work] });

    await user.click(within(await rowOf("work")).getByRole("button", { name: "Actions for work" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename work" });
    await user.clear(within(dialog).getByLabelText("Label"));
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(await within(dialog).findByText("Enter a label.")).toBeDefined();
    expect(state.requests.filter((request) => request.startsWith("PATCH"))).toEqual([]);
  });

  it("just closes when the label is unchanged", async () => {
    const { state, user } = renderApp("/accounts", { accounts: [work] });

    await user.click(within(await rowOf("work")).getByRole("button", { name: "Actions for work" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename work" });
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.requests.filter((request) => request.startsWith("PATCH"))).toEqual([]);
  });

  it("says which account it couldn't remove, and that it can be signed in again", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] }, [
      http.delete("*/admin/accounts/:id", () => HttpResponse.error()),
    ]);

    await user.click(within(await rowOf("work")).getByRole("button", { name: "Actions for work" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove work?" });
    expect(confirm.textContent).toContain("You can add it again by signing in.");
    await user.click(within(confirm).getByRole("button", { name: "Remove account" }));

    await errorToast("Couldn't remove work");
  });

  it("says why a rename failed in the form, and keeps it open", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] }, [
      http.patch("*/admin/accounts/:id", () => HttpResponse.error()),
    ]);

    await user.click(within(await rowOf("work")).getByRole("button", { name: "Actions for work" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename work" });
    await user.type(within(dialog).getByLabelText("Label"), "2");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(await within(dialog).findByText(/Can't reach via/)).toBeDefined();
    expect(within(dialog).getByLabelText("Label").getAttribute("aria-invalid")).toBe("true");
  });

  it("gives focus back to the row's actions once a dialog closes", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] });
    const trigger = within(await rowOf("work")).getByRole("button", { name: "Actions for work" });

    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename work" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("moves focus to the page's heading once the removed account's dialog closes", async () => {
    const { user } = renderApp("/accounts", { accounts: [work, home] });

    await user.click(within(await rowOf("home")).getByRole("button", { name: "Actions for home" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove home?" });
    await user.click(within(confirm).getByRole("button", { name: "Remove account" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1, name: "Accounts" }),
      ),
    );
  });

  it("flips an account's switch at once, and says it's busy until via answers", async () => {
    let patches = 0;

    const { state, user } = renderApp("/accounts", { accounts: [work] }, [
      http.patch("*/admin/accounts/:id", async () => {
        patches += 1;
        await delay("infinite");
      }),
    ]);

    const toggle = within(await rowOf("work")).getByRole("switch", { name: "work enabled" });

    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-busy")).toBe("true");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(patches).toBe(1);
    expect(state.accounts[0]?.enabled).toBe(true);
  });

  it("keeps a switch flipped while via pushes its state from before the flip", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] }, [
      http.patch("*/admin/accounts/:id", () => delay("infinite")),
    ]);

    const toggle = within(await rowOf("work")).getByRole("switch", { name: "work enabled" });

    await user.click(toggle);
    act(() =>
      openSource().push({
        session: true,
        version: "0.0.0",
        pool: { accounts: [], opencodeGo: [], providers: [] },
        usage: { accounts: [], opencodeGo: [], openrouter: null, refreshing: false },
        accounts: [work],
        opencodeGo: [],
        keys: [],
        models: [],
        ollama: null,
        openrouter: null,
      }),
    );

    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("flips an account's switch back, and says so, when via refuses", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] }, [
      http.patch("*/admin/accounts/:id", () => HttpResponse.error()),
    ]);

    const toggle = within(await rowOf("work")).getByRole("switch", { name: "work enabled" });

    await user.click(toggle);

    await errorToast("Couldn't disable work");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("says when the accounts didn't load, rather than that there are none, and tries again", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] }, [
      http.get("*/admin/accounts", () => new HttpResponse(null, { status: 500 }), { once: true }),
    ]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load accounts");
    expect(screen.getByRole("heading", { level: 1, name: "Accounts" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "No accounts yet" })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await rowOf("work")).toBeDefined();
  });

  it("shows a stand-in table while the accounts load", async () => {
    fakeClock();
    renderApp("/accounts", {}, [http.get("*/admin/accounts", () => delay("infinite"))]);

    // The router shows it once loading takes a moment, 1 s.
    await skip(1_000);
    const codex = await screen.findByRole("region", { name: "ChatGPT (Codex)" });

    expect(within(codex).getByRole("status").textContent).toBe("Loading accounts");
  });

  it("disables and enables an account from its switch", async () => {
    const { state, user } = renderApp("/accounts", { accounts: [work] });
    const toggle = within(await rowOf("work")).getByRole("switch", { name: "work enabled" });

    await user.click(toggle);
    await waitFor(() => expect(state.accounts[0]?.enabled).toBe(false));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    await waitFor(() => expect(toggle.getAttribute("aria-busy")).not.toBe("true"));

    await user.click(toggle);
    await waitFor(() => expect(state.accounts[0]?.enabled).toBe(true));
  });

  it("removes an account once the viewer confirms", async () => {
    const { state, user } = renderApp("/accounts", { accounts: [work, home] });

    await user.click(within(await rowOf("home")).getByRole("button", { name: "Actions for home" }));
    const item = await screen.findByRole("menuitem", { name: "Remove…" });
    expect(item.hasAttribute("data-destructive")).toBe(true);
    await user.click(item);
    const confirm = await screen.findByRole("alertdialog", { name: "Remove home?" });
    const remove = within(confirm).getByRole("button", { name: "Remove account" });
    expect(remove.getAttribute("data-variant")).toBe("destructive");
    await user.click(remove);

    await waitFor(() => expect(screen.queryByText("home")).toBeNull());
    expect(state.accounts.map((a) => a.id)).toEqual(["acc-1"]);
  });

  it("offers to add the first account once, in the header, when there are none", async () => {
    renderApp("/accounts");

    const empty = await screen.findByRole("region", { name: "No accounts yet" });
    expect(within(empty).queryByRole("button")).toBeNull();
    expect(
      within(
        await screen.findByRole("region", { name: "No OpenCode Go accounts yet" }),
      ).queryByRole("button"),
    ).toBeNull();
    expect(screen.getAllByRole("button", { name: "Add account" })).toHaveLength(1);
  });
});

describe("adding an account", () => {
  // Swapping in a new dialog would drop the backdrop for a frame and fade the
  // next one in from nothing: the undimmed page flashes between the steps.
  it.each([
    [/ChatGPT \(Codex\)/, "Add a ChatGPT account"],
    [/OpenCode Go/, "Add an OpenCode Go account"],
  ])("moves on from the choice to %s in the same dialog", async (choice, title) => {
    const { user } = renderApp("/accounts", {
      accounts: [work],
      nextLogin: [{ status: "pending" }],
    });

    await rowOf("work");
    await user.click(screen.getByRole("button", { name: "Add account" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an account" });
    await user.click(within(dialog).getByRole("button", { name: choice }));

    expect(await screen.findByRole("dialog", { name: title })).toBe(dialog);
  });

  it("keeps one dialog from choosing the kind to adding it, and starts over once closed", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] });

    await rowOf("work");
    await user.click(screen.getAllByRole("button", { name: "Add account" })[0] ?? document.body);
    const choose = await screen.findByRole("dialog", { name: "Add an account" });
    await user.click(within(choose).getByRole("button", { name: /OpenCode Go/ }));

    const key = await screen.findByRole("dialog", { name: "Add an OpenCode Go account" });
    expect(key).toBe(choose);
    await waitFor(() => expect(document.activeElement).toBe(within(key).getByLabelText("API key")));

    await user.click(within(key).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getAllByRole("button", { name: "Add account" })[0] ?? document.body);
    expect(await screen.findByRole("dialog", { name: "Add an account" })).toBeDefined();
  });

  it("can start at the ChatGPT sign-in, as signing a locked-out account in again does", async () => {
    server.use(...adminHandlers(createAdminState()));

    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <SignInAgain />
        </ToastProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));

    const dialog = await screen.findByRole("dialog", { name: "Add a ChatGPT account" });
    expect(await within(dialog).findByText("WXYZ-2345")).toBeDefined();
  });

  it("asks which kind to add, and can be cancelled there", async () => {
    const { user } = renderApp("/accounts");

    await screen.findByRole("region", { name: "No accounts yet" });
    await user.click(screen.getByRole("button", { name: "Add account" }));
    const choose = await screen.findByRole("dialog", { name: "Add an account" });
    expect(within(choose).getByText("Choose the kind of account to add.")).toBeDefined();
    await user.click(within(choose).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("adds an OpenCode Go account from its API key, asking for one first", async () => {
    const { state, user } = renderApp("/accounts");

    await screen.findByRole("region", { name: "No accounts yet" });
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /OpenCode Go/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add an OpenCode Go account" });
    await user.click(within(dialog).getByRole("button", { name: "Add account" }));
    expect(await within(dialog).findByText("Paste the OpenCode Go API key.")).toBeDefined();

    await user.type(within(dialog).getByLabelText("API key"), "sk-go-5678");
    await user.click(within(dialog).getByRole("button", { name: "Add account" }));

    expect(await screen.findByRole("dialog", { name: "Account added" })).toBeDefined();
    expect(state.opencodeGo).toHaveLength(1);
  });

  it("shows the code to enter, polls until the account is added, then says so", async () => {
    const added = account({ id: "acc-9", label: "new" });
    fakeClock();

    const { user } = renderApp("/accounts", {
      nextLogin: [{ status: "pending" }, { status: "added", account: added }],
    });

    await screen.findByRole("region", { name: "No accounts yet" });
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));

    const dialog = await screen.findByRole("dialog", { name: "Add a ChatGPT account" });
    expect(await within(dialog).findByText("WXYZ-2345")).toBeDefined();
    expect(
      within(dialog).getByText(
        "Open the sign-in page and sign in to the ChatGPT account you want to add.",
      ),
    ).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Copy Your code" })).toBeDefined();

    expect(
      within(dialog)
        .getByRole("link", { name: "Open sign-in page (opens in a new tab)" })
        .getAttribute("href"),
    ).toBe("https://auth.openai.com/codex/device");

    // The first poll says pending; the next, 2 s later, says added.
    await skip(2_000);
    expect(await screen.findByRole("dialog", { name: "Account added" })).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add a ChatGPT account" })).toBeNull(),
    );
    expect(await rowOf("new")).toBeDefined();
  });

  it("says an account already in the pool was signed in again, rather than added", async () => {
    const { user, state } = renderApp("/accounts", {
      accounts: [work],
      nextLogin: [{ status: "updated", account: work }],
    });

    await rowOf("work");
    await user.click(screen.getAllByRole("button", { name: "Add account" })[0] ?? document.body);
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));

    const toast = await screen.findByRole("dialog", { name: "Signed in again" });
    expect(toast.textContent).toContain("via has fresh tokens for work.");
    expect(screen.queryByRole("dialog", { name: "Account added" })).toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add a ChatGPT account" })).toBeNull(),
    );
    expect(state.accounts).toEqual([work]);
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
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Sign-in didn't finish: The code expired",
    );
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeDefined();
  });

  it("starts a new login on Try again, which can then go through", async () => {
    const { user, state } = renderApp("/accounts", {
      accounts: [work],
      nextLogin: [{ status: "failed", error: "The code expired" }],
    });

    await rowOf("work");
    await user.click(screen.getAllByRole("button", { name: "Add account" })[0] ?? document.body);
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a ChatGPT account" });
    await within(dialog).findByRole("alert");

    state.nextLogin = [{ status: "added", account: home }];
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("dialog", { name: "Account added" })).toBeDefined();
    expect(await rowOf("home")).toBeDefined();
  });

  it("says why when via can't start the login", async () => {
    const { user } = renderApp("/accounts", { accounts: [work] }, [
      http.post("*/admin/accounts/logins", () => HttpResponse.error()),
    ]);

    await rowOf("work");
    await user.click(screen.getAllByRole("button", { name: "Add account" })[0] ?? document.body);
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));

    const dialog = await screen.findByRole("dialog", { name: "Add a ChatGPT account" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Can't reach via");
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeDefined();
  });

  it("fetches the models again once an account is added, as they are its accounts' models", async () => {
    const { user, state } = renderApp("/models", {
      nextLogin: [{ status: "added", account: home }],
    });

    await screen.findByRole("heading", { name: "Models" });
    await user.click(screen.getByRole("link", { name: "Accounts" }));
    await screen.findByRole("region", { name: "No accounts yet" });
    await user.click(screen.getByRole("button", { name: "Add account" }));
    state.models = [{ id: "gpt-5.5", object: "model", created: 0, owned_by: "openai" }];
    await user.click(await screen.findByRole("button", { name: /ChatGPT \(Codex\)/ }));
    await screen.findByRole("dialog", { name: "Account added" });

    await user.click(screen.getByRole("link", { name: "Models" }));
    expect(await screen.findByText("gpt-5.5")).toBeDefined();
  });
});

const imported = opencodeGoAccount({
  id: "go-2",
  label: "OpenCode Go (imported)",
  key: "…9999",
  environmentVariable: "OPENCODE_API_KEY",
});

const goRow = (label: string) => rowOf(label, "OpenCode Go accounts");

describe("the accounts page's OpenCode Go accounts", () => {
  it("lists them apart from the ChatGPT accounts, each key masked", async () => {
    renderApp("/accounts", { accounts: [work], opencodeGo: [main] });

    const codex = await screen.findByRole("region", { name: "ChatGPT (Codex)" });
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

  it("renames, disables and removes one, once the viewer confirms", async () => {
    const { state, user } = renderApp("/accounts", { opencodeGo: [main] });

    await user.click(
      within(await goRow("go main")).getByRole("button", { name: "Actions for go main" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const rename = await screen.findByRole("dialog", { name: "Rename go main" });
    const input = within(rename).getByLabelText("Label");
    await user.clear(input);
    await user.type(input, "go work");
    await user.click(within(rename).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(state.opencodeGo[0]?.label).toBe("go work"));
    expect(await screen.findByRole("dialog", { name: "Account renamed" })).toBeDefined();

    await user.click(
      within(await goRow("go work")).getByRole("switch", { name: "go work enabled" }),
    );
    await waitFor(() => expect(state.opencodeGo[0]?.enabled).toBe(false));

    await user.click(
      within(await goRow("go work")).getByRole("button", { name: "Actions for go work" }),
    );
    const item = await screen.findByRole("menuitem", { name: "Remove…" });
    expect(item.hasAttribute("data-destructive")).toBe(true);
    await user.click(item);
    const confirm = await screen.findByRole("alertdialog", { name: "Remove go work?" });
    const remove = within(confirm).getByRole("button", { name: "Remove account" });
    expect(remove.getAttribute("data-variant")).toBe("destructive");
    await user.click(remove);

    await waitFor(() => expect(state.opencodeGo).toEqual([]));
    expect(await screen.findByRole("dialog", { name: "Account removed" })).toBeDefined();
    expect(
      await screen.findByRole("region", { name: "No OpenCode Go accounts yet" }),
    ).toBeDefined();
  });

  it("says when they didn't load, rather than that there are none, and tries again", async () => {
    const { user } = renderApp("/accounts", { opencodeGo: [main] }, [
      http.get("*/admin/opencode-go/accounts", () => new HttpResponse(null, { status: 500 }), {
        once: true,
      }),
    ]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load accounts");
    expect(screen.getByRole("heading", { level: 1, name: "Accounts" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "No OpenCode Go accounts yet" })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await goRow("go main")).toBeDefined();
  });
});
