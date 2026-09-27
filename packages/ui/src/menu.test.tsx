import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./index.ts";

function AccountActions({
  onRename,
  onRemove,
}: {
  readonly onRename: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost">Actions</Button>} />
      <MenuContent>
        <MenuItem label="Rename" onClick={onRename} />
        <MenuItem label="Disable" disabled />
        <MenuSeparator />
        <MenuItem label="Remove" onClick={onRemove} />
      </MenuContent>
    </Menu>
  );
}

describe("Menu", () => {
  it("opens a menu of items from a trigger that says it has one", async () => {
    const user = userEvent.setup();
    render(<AccountActions onRename={vi.fn()} onRemove={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    await user.click(trigger);

    const menu = await screen.findByRole("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Disable",
      "Remove",
    ]);
    expect(screen.getByRole("menuitem", { name: "Disable" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(menu.querySelector("[role='separator']")).not.toBeNull();
  });

  it("walks the items with the arrow keys and picks with Enter", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<AccountActions onRename={vi.fn()} onRemove={onRemove} />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();

    await user.keyboard("{ArrowDown}");
    await screen.findByRole("menu");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Rename"));
    // A disabled item stays focusable, so it can be found, but does nothing.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Disable");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeDefined();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Remove");
    await user.keyboard("{Enter}");

    expect(onRemove).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<AccountActions onRename={vi.fn()} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
