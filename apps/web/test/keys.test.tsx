import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "./app.tsx";

const laptop = { id: "key-1", name: "laptop", createdAt: "2026-09-01T10:00:00.000Z" };

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

  it("revokes a key once the viewer confirms", async () => {
    const { state, user } = renderApp("/keys", { keys: [laptop] });

    await user.click(await screen.findByRole("button", { name: "Revoke laptop" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke laptop?" });
    await user.click(within(confirm).getByRole("button", { name: "Revoke key" }));

    expect(await screen.findByRole("region", { name: "No keys yet" })).toBeDefined();
    expect(state.keys).toEqual([]);
  });
});
