import { act, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClock, renderApp, skip } from "./app.tsx";

const laptop = {
  id: "key-1",
  name: "laptop",
  createdAt: "2026-09-01T10:00:00.000Z",
  lastUsedAt: null,
};

const now = new Date("2026-09-27T12:00:00.000Z");

/** The table row that names `name`. */
const rowOf = (name: string) => screen.findByRole("row", { name: new RegExp(`^${name}`) });

afterEach(() => vi.useRealTimers());

/** An error toast, as it's announced: Base UI reads it out through an alert. */
const errorToast = (title: string) =>
  waitFor(() =>
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.startsWith(title))).toBe(
      true,
    ),
  );

describe("the keys page", () => {
  it("creates a key and shows it once, never again", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.type(within(form).getByLabelText("Name"), "ci");
    await user.click(within(form).getByRole("button", { name: "Create key" }));

    const reveal = await screen.findByRole("dialog", { name: "Your new key: ci" });
    expect(within(reveal).getByText("via-sk-key-2-0123456789abcdef")).toBeDefined();
    // The submit button went with the form, so focus moves on to copying the key.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(reveal).getByRole("button", { name: "Copy API key" }),
      ),
    );
    expect(within(reveal).getByRole("note").textContent).toContain("You won't see this key again");

    await user.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const table = screen.getByRole("table", { name: "Keys" });
    expect(await within(table).findByText("ci")).toBeDefined();
    expect(screen.queryByText("via-sk-key-2-0123456789abcdef")).toBeNull();
  });

  it("says when a key with that name already exists", async () => {
    const { state, user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.type(within(form).getByLabelText("Name"), "laptop");
    await user.click(within(form).getByRole("button", { name: "Create key" }));

    expect(
      await within(form).findByText('A key named "laptop" already exists. Choose another name.'),
    ).toBeDefined();
    expect(within(form).getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    expect(state.keys).toHaveLength(1);
  });

  it("shows when each key was last used, ticking, with the full time on hover", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    const threeMinutesAgo = new Date(now.getTime() - 3 * 60_000).toISOString();

    renderApp("/keys", {
      keys: [
        { ...laptop, lastUsedAt: threeMinutesAgo },
        { ...laptop, id: "key-2", name: "ci" },
      ],
    });

    expect(
      within(await screen.findByRole("table", { name: "Keys" }))
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Name", "ID", "Added", "Last used", "Actions"]);

    const used = within(await rowOf("laptop")).getByText("3 min ago");
    expect(used.tagName).toBe("TIME");
    expect(used.getAttribute("dateTime")).toBe(threeMinutesAgo);
    expect(used.getAttribute("title")).toContain("2026");
    expect(within(await rowOf("ci")).getByText("Never")).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(used.textContent).toBe("4 min ago");
  });

  it("puts each key's actions in its row's last cell", async () => {
    renderApp("/keys", { keys: [laptop] });

    const row = within(await rowOf("laptop"));
    const last = row.getAllByRole("cell").at(-1);
    expect(last?.contains(row.getByRole("button", { name: "Actions for laptop" }))).toBe(true);
  });

  it("shows when each key was added, with the full time on hover", async () => {
    renderApp("/keys", { keys: [laptop] });

    const added = within(await rowOf("laptop"))
      .getAllByRole("cell")
      .map((cell) => cell.querySelector("time"))
      .find((time) => time?.getAttribute("dateTime") === laptop.createdAt);

    expect(added?.getAttribute("title")).toContain("2026");
  });

  it("cuts a long name short, keeping all of it on hover", async () => {
    const long = "a key name far too long to fit in its column without being cut short";
    renderApp("/keys", { keys: [{ ...laptop, name: long }] });

    expect(
      within(await rowOf(long))
        .getByText(long)
        .getAttribute("title"),
    ).toBe(long);
    expect(
      within(await rowOf(long))
        .getByText("key-1")
        .getAttribute("title"),
    ).toBe("key-1");
  });

  it("renames a key from its menu", async () => {
    const { state, user } = renderApp("/keys", { keys: [laptop] });

    await user.click(
      within(await rowOf("laptop")).getByRole("button", { name: "Actions for laptop" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename laptop" });
    const input = within(dialog).getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "desktop");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    // By name: the "Key renamed" toast is a dialog too.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename laptop" })).toBeNull());
    expect(await screen.findByRole("dialog", { name: "Key renamed" })).toBeDefined();
    expect(await rowOf("desktop")).toBeDefined();
    expect(state.keys).toEqual([{ ...laptop, name: "desktop" }]);
  });

  it("says when another key already has the new name, and keeps the dialog open", async () => {
    const ci = { ...laptop, id: "key-2", name: "ci" };
    const { state, user } = renderApp("/keys", { keys: [laptop, ci] });

    await user.click(
      within(await rowOf("laptop")).getByRole("button", { name: "Actions for laptop" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename laptop" });
    const input = within(dialog).getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "ci");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(
      await within(dialog).findByText('A key named "ci" already exists. Choose another name.'),
    ).toBeDefined();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Rename laptop" })).toBe(dialog);
    expect(state.keys).toEqual([laptop, ci]);
  });

  it("asks for a name rather than renaming a key to nothing", async () => {
    const { state, user } = renderApp("/keys", { keys: [laptop] });

    await user.click(
      within(await rowOf("laptop")).getByRole("button", { name: "Actions for laptop" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename laptop" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(await within(dialog).findByText("Enter a name.")).toBeDefined();
    expect(state.keys).toEqual([laptop]);
  });

  it("revokes a key from its menu once the viewer confirms", async () => {
    const { state, user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Actions for laptop" }));
    const item = await screen.findByRole("menuitem", { name: "Revoke…" });
    expect(item.hasAttribute("data-destructive")).toBe(true);
    await user.click(item);
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke laptop?" });
    const revoke = within(confirm).getByRole("button", { name: "Revoke key" });
    expect(revoke.getAttribute("data-variant")).toBe("destructive");
    await user.click(revoke);

    expect(await screen.findByRole("region", { name: "No keys yet" })).toBeDefined();
    expect((await screen.findByRole("dialog", { name: "Key revoked" })).textContent).toContain(
      "Clients using laptop are now refused (401 Unauthorized).",
    );
    expect(state.keys).toEqual([]);
  });

  it("moves focus to the page's heading once the revoked key's dialog closes", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Actions for laptop" }));
    await user.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke laptop?" });
    await user.click(within(confirm).getByRole("button", { name: "Revoke key" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Keys" })),
    );
  });

  it("keeps Cancel from closing the confirmation while the key is being revoked", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] }, [
      http.delete("*/admin/keys/:idOrName", () => delay("infinite")),
    ]);

    await user.click(await screen.findByRole("button", { name: "Actions for laptop" }));
    await user.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke laptop?" });
    await user.click(within(confirm).getByRole("button", { name: "Revoke key" }));

    await waitFor(() =>
      expect(within(confirm).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
  });

  it("says when the keys didn't load, rather than that there are none, and tries again", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] }, [
      http.get("*/admin/keys", () => new HttpResponse(null, { status: 500 }), { once: true }),
    ]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load keys");
    expect(screen.getByRole("heading", { level: 1, name: "Keys" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "No keys yet" })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await rowOf("laptop")).toBeDefined();
  });

  it("shows a stand-in table while the keys load", async () => {
    fakeClock();
    renderApp("/keys", {}, [http.get("*/admin/keys", () => delay("infinite"))]);

    // The router shows it once loading takes a moment, 1 s.
    await skip(1_000);
    expect((await screen.findByRole("status")).textContent).toBe("Loading keys");
  });

  it("titles the empty state under the page's own heading", async () => {
    renderApp("/keys");

    const empty = await screen.findByRole("region", { name: "No keys yet" });
    expect(within(empty).getByRole("heading", { level: 2, name: "No keys yet" })).toBeDefined();
  });
});

describe("creating a key", () => {
  it("names the key in a plain field the browser won't fill or correct", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Create key" }));

    const input = within(
      await screen.findByRole("dialog", { name: "Create a key" }),
    ).getByLabelText("Name");

    expect(input.getAttribute("name")).toBe("name");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
  });

  it("clears the taken-name error once the name changes", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.type(within(form).getByLabelText("Name"), "laptop");
    await user.click(within(form).getByRole("button", { name: "Create key" }));
    await within(form).findByText('A key named "laptop" already exists. Choose another name.');

    await user.type(within(form).getByLabelText("Name"), "2");
    await waitFor(() =>
      expect(
        within(form).queryByText('A key named "laptop" already exists. Choose another name.'),
      ).toBeNull(),
    );
  });

  it("gives focus back to Create key once the dialog closes", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] });
    const create = await screen.findByRole("button", { name: "Create key" });

    await user.click(create);
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.click(within(form).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(create));
  });

  it("moves focus to the page's heading once the first key is made, as its button is gone", async () => {
    const { user } = renderApp("/keys");

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.type(within(form).getByLabelText("Name"), "ci");
    await user.click(within(form).getByRole("button", { name: "Create key" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Your new key: ci" })).getByRole("button", {
        name: "Done",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Keys" })),
    );
  });

  it("asks for a name rather than creating a nameless key", async () => {
    const { state, user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.click(within(form).getByRole("button", { name: "Create key" }));

    expect(await within(form).findByText("Enter a name for the key.")).toBeDefined();
    expect(state.keys).toHaveLength(1);
  });

  it("says which key it couldn't revoke", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] }, [
      http.delete("*/admin/keys/:idOrName", () => HttpResponse.error()),
    ]);

    await user.click(await screen.findByRole("button", { name: "Actions for laptop" }));
    await user.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    await user.click(
      within(await screen.findByRole("alertdialog", { name: "Revoke laptop?" })).getByRole(
        "button",
        { name: "Revoke key" },
      ),
    );

    await errorToast("Couldn't revoke laptop");
  });

  it("says why when via can't create it", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] }, [
      http.post("*/admin/keys", () => HttpResponse.error()),
    ]);

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.type(within(form).getByLabelText("Name"), "ci");
    await user.click(within(form).getByRole("button", { name: "Create key" }));

    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("Can't reach via");
  });

  it("starts over on a fresh form when opened again", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.type(within(form).getByLabelText("Name"), "ci");
    await user.click(within(form).getByRole("button", { name: "Create key" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Your new key: ci" })).getByRole("button", {
        name: "Done",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Create key" }));
    const again = await screen.findByRole("dialog", { name: "Create a key" });
    expect(within(again).getByLabelText("Name")).toHaveProperty("value", "");
  });
});
