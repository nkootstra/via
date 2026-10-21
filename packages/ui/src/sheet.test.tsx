import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Button, Sheet, SheetContent } from "./index.ts";

function Request() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>View request</Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          title="Request of turn 3"
          description="As via kept it."
          actions={<Button size="compact">Copy JSON</Button>}
        >
          <p>The prompt</p>
        </SheetContent>
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("opens beside the page as a dialog named and described by its title and description", async () => {
    const user = userEvent.setup();
    render(<Request />);

    await user.click(screen.getByRole("button", { name: "View request" }));

    const sheet = await screen.findByRole("dialog", { name: "Request of turn 3" });
    const describedBy = sheet.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("As via kept it.");
    expect(sheet.textContent).toContain("The prompt");
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeDefined();
  });

  it("closes on Escape and on its ✕, focus back on what opened it", async () => {
    const user = userEvent.setup();
    render(<Request />);
    const trigger = screen.getByRole("button", { name: "View request" });

    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
