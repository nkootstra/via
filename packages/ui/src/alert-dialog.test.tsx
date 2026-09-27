import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Button,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./index.ts";

function RevokeKey({ onRevoke }: { readonly onRevoke: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="tertiary">Revoke</Button>} />
      <AlertDialogContent>
        <DialogTitle>Revoke this key?</DialogTitle>
        <DialogDescription>Clients using it stop working at once.</DialogDescription>
        <DialogFooter>
          <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
          <Button onClick={onRevoke}>Revoke key</Button>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe("AlertDialog", () => {
  it("opens as an alert dialog with no dismiss button of its own", async () => {
    const user = userEvent.setup();
    render(<RevokeKey onRevoke={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Revoke this key?" });
    expect(dialog.querySelector("[aria-label='Close']")).toBeNull();
  });

  it("stays open on an outside click", async () => {
    const user = userEvent.setup();
    render(<RevokeKey onRevoke={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await screen.findByRole("alertdialog");

    await user.click(document.body);

    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  it("confirms, or cancels back to its trigger", async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn();
    render(<RevokeKey onRevoke={onRevoke} />);
    const trigger = screen.getByRole("button", { name: "Revoke" });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Revoke key" }));
    expect(onRevoke).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
