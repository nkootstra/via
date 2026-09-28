import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MenuItem, RowActions } from "./index.ts";

describe("RowActions", () => {
  it("opens the row's menu from a named icon button, aligned to its end", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(
      <RowActions label="Actions for work">
        <MenuItem label="Rename" onClick={onRename} />
        <MenuItem label="Remove" destructive />
      </RowActions>,
    );
    const trigger = screen.getByRole("button", { name: "Actions for work" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    await user.click(trigger);

    const menu = await screen.findByRole("menu");
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Remove",
    ]);
    expect(menu.closest("[data-align]")?.getAttribute("data-align")).toBe("end");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledOnce();
  });
});
