import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuLinkItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./index.ts";

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
        <MenuItem label="Remove" destructive onClick={onRemove} />
      </MenuContent>
    </Menu>
  );
}

function Sizes({ onValueChange }: { readonly onValueChange: (value: string) => void }) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost">View</Button>} />
      <MenuContent>
        <MenuRadioGroup label="Size" value="small" onValueChange={onValueChange}>
          <MenuRadioItem value="small" label="Small" />
          <MenuRadioItem value="large" label="Large" icon={<svg data-testid="large" />} />
        </MenuRadioGroup>
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

  it("marks a destructive item, and tints the highlight only while it is lit", async () => {
    const user = userEvent.setup();
    render(<AccountActions onRename={vi.fn()} onRemove={vi.fn()} />);
    screen.getByRole("button", { name: "Actions" }).focus();
    await user.keyboard("{ArrowDown}");
    const menu = await screen.findByRole("menu");
    const remove = screen.getByRole("menuitem", { name: "Remove" });
    expect(remove.hasAttribute("data-destructive")).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Rename" }).hasAttribute("data-destructive")).toBe(
      false,
    );

    const tinted = () => menu.querySelector("[data-highlight][data-destructive]") !== null;
    await waitFor(() => expect(menu.querySelector("[data-highlight]")).not.toBeNull());
    expect(tinted()).toBe(false);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(remove));
    await waitFor(() => expect(tinted()).toBe(true));

    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(tinted()).toBe(false));
  });

  it("draws an item's icon before its label, hidden from its name", async () => {
    const user = userEvent.setup();
    render(
      <Menu>
        <MenuTrigger render={<Button variant="ghost">Actions</Button>} />
        <MenuContent>
          <MenuItem label="Remove" icon={<svg data-testid="trash" />} destructive />
        </MenuContent>
      </Menu>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));

    const item = await screen.findByRole("menuitem", { name: "Remove" });
    expect(item.textContent).toBe("Remove");
    expect(item.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(item.firstElementChild?.contains(screen.getByTestId("trash"))).toBe(true);
  });

  it("offers a link as an item, which closes the menu when followed", async () => {
    const user = userEvent.setup();
    const followed = vi.fn();
    render(
      <Menu>
        <MenuTrigger render={<Button variant="ghost">Account</Button>} />
        <MenuContent>
          <MenuLinkItem
            label="Settings"
            icon={<svg data-testid="gear" />}
            render={(props) => (
              <a
                {...props}
                href="#settings"
                onClick={(event) => {
                  props.onClick?.(event);
                  followed();
                }}
              >
                {props.children}
              </a>
            )}
          />
        </MenuContent>
      </Menu>,
    );
    await user.click(screen.getByRole("button", { name: "Account" }));

    const item = await screen.findByRole("menuitem", { name: "Settings" });
    expect(item.tagName).toBe("A");
    expect(item.getAttribute("href")).toBe("#settings");
    expect(item.firstElementChild?.getAttribute("aria-hidden")).toBe("true");

    await user.click(item);

    expect(followed).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<AccountActions onRename={vi.fn()} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  describe("a choice of one", () => {
    it("is a named group of items, the chosen one checked", async () => {
      const user = userEvent.setup();
      render(<Sizes onValueChange={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "View" }));

      const group = await screen.findByRole("group", { name: "Size" });
      expect(within(group).getAllByRole("menuitemradio")).toHaveLength(2);
      const small = within(group).getByRole("menuitemradio", { name: "Small" });
      const large = within(group).getByRole("menuitemradio", { name: "Large" });
      expect(small.getAttribute("aria-checked")).toBe("true");
      expect(large.getAttribute("aria-checked")).toBe("false");
    });

    it("picks with a click and closes, back on its trigger", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(<Sizes onValueChange={onValueChange} />);
      const trigger = screen.getByRole("button", { name: "View" });
      await user.click(trigger);

      await user.click(await screen.findByRole("menuitemradio", { name: "Large" }));

      expect(onValueChange).toHaveBeenCalledWith("large");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(document.activeElement).toBe(trigger);
    });
  });
});
