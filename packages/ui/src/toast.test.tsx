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

/** Adds an error toast, and shows each toast's priority and timeout. */
function Probe() {
  const toast = useToast();

  return (
    <>
      <Button
        onClick={() =>
          toast.add({
            title: "Couldn't revoke",
            type: "error",
            actionProps: { children: "Try again" },
          })
        }
      >
        Fail
      </Button>
      <output>
        {toast.toasts.map((each) => `${each.priority ?? "low"}:${each.timeout ?? "default"}`)}
      </output>
    </>
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

  it("offers an action button, which a toast that stays until acted on can use", async () => {
    const user = userEvent.setup();
    let reloaded = 0;

    function Updated() {
      const toast = useToast();

      return (
        <Button
          onClick={() =>
            toast.add({
              title: "Updated",
              timeout: 0,
              actionProps: { children: "Reload", onClick: () => reloaded++ },
            })
          }
        >
          Update
        </Button>
      );
    }

    render(
      <ToastProvider>
        <Updated />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Update" }));
    const toast = await screen.findByRole("dialog", { name: "Updated" });

    await user.click(within(toast).getByRole("button", { name: "Reload" }));

    expect(reloaded).toBe(1);
  });

  it("keeps an error until it is dismissed, and says it at once", async () => {
    const user = userEvent.setup();

    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Fail" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("high:0"));
  });

  it("keeps a hidden error toast out of the tab order until the stack is reached", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Fail" }));
    await screen.findAllByText("Couldn't revoke");

    const hidden = [...document.querySelectorAll("[aria-hidden='true']")];

    const focusable = hidden.flatMap((element) =>
      [element, ...element.querySelectorAll("button, [tabindex]")].filter(
        (each) =>
          (each.getAttribute("tabindex") ?? (each.tagName === "BUTTON" ? "0" : "-1")) !== "-1",
      ),
    );

    expect(focusable).toEqual([]);
  });
});
