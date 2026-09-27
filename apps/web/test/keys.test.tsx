import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "./app.tsx";

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

describe("the keys page", () => {
  it("creates a key and shows it once, never again", async () => {
    const { user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.type(within(form).getByLabelText("Name"), "ci");
    await user.click(within(form).getByRole("button", { name: "Create key" }));

    const reveal = await screen.findByRole("dialog", { name: "Your new key: ci" });
    expect(within(reveal).getByText("via-sk-key-2-0123456789abcdef")).toBeDefined();
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

    expect(await within(form).findByText('A key named "laptop" already exists.')).toBeDefined();
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
    ).toEqual(["Name", "Id", "Created", "Last used", "Actions"]);

    const used = within(await rowOf("laptop")).getByText("3 min ago");
    expect(used.tagName).toBe("TIME");
    expect(used.getAttribute("dateTime")).toBe(threeMinutesAgo);
    expect(used.getAttribute("title")).toContain("2026");
    expect(within(await rowOf("ci")).getByText("Never")).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(used.textContent).toBe("4 min ago");
  });

  it("puts each key's Revoke button, in red with a trash icon, in its row's last cell", async () => {
    renderApp("/keys", { keys: [laptop] });

    const row = within(await rowOf("laptop"));
    const revoke = row.getByRole("button", { name: "Revoke laptop" });
    expect(row.getAllByRole("cell").at(-1)?.contains(revoke)).toBe(true);
    expect(revoke.textContent).toBe("Revoke");
    expect(revoke.getAttribute("data-variant")).toBe("destructive");
    expect(revoke.querySelector("svg")).not.toBeNull();
  });

  it("revokes a key once the viewer confirms", async () => {
    const { state, user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Revoke laptop" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke laptop?" });
    const revoke = within(confirm).getByRole("button", { name: "Revoke key" });
    expect(revoke.getAttribute("data-variant")).toBe("destructive");
    await user.click(revoke);

    expect(await screen.findByRole("region", { name: "No keys yet" })).toBeDefined();
    expect(state.keys).toEqual([]);
  });
});
