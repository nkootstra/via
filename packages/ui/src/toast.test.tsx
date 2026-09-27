import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Button, ToastProvider, useToast } from "./index.ts";

function RevokeButton() {
  const toast = useToast();

  return (
    <Button
      onClick={() =>
        toast.add({ title: "Key revoked", description: "Clients using it now get 401." })
      }
    >
      Revoke
    </Button>
  );
}

describe("Toast", () => {
  it("announces a new toast through a polite live region", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <RevokeButton />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    const toast = await within(region).findByRole("dialog", { name: "Key revoked" });
    const descriptionId = toast.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toBe(
      "Clients using it now get 401.",
    );
  });

  it("dismisses from its Close button, which the stack reveals on hover", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <RevokeButton />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const toast = await screen.findByRole("dialog", { name: "Key revoked" });

    await user.hover(toast);
    await user.click(within(toast).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
