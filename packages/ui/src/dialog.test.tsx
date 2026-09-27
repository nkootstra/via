import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  Input,
} from "./index.ts";

function RenameDialog() {
  return (
    <Dialog>
      <DialogTrigger render={<Button>Rename</Button>} />
      <DialogContent>
        <DialogTitle>Rename account</DialogTitle>
        <DialogDescription>The label shows in usage and logs.</DialogDescription>
        <Input aria-label="Label" />
        <DialogFooter>
          <Button>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("opens as a dialog named and described by its title and description", async () => {
    const user = userEvent.setup();
    render(<RenameDialog />);

    await user.click(screen.getByRole("button", { name: "Rename" }));

    const dialog = await screen.findByRole("dialog", { name: "Rename account" });
    const descriptionId = dialog.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toBe(
      "The label shows in usage and logs.",
    );
  });

  it("keeps focus inside while open", async () => {
    const user = userEvent.setup();
    render(<RenameDialog />);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    for (let step = 0; step < 5; step++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("closes on Escape and hands focus back to its trigger", async () => {
    const user = userEvent.setup();
    render(<RenameDialog />);
    const trigger = screen.getByRole("button", { name: "Rename" });
    await user.click(trigger);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from its Close button", async () => {
    const user = userEvent.setup();
    render(<RenameDialog />);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
