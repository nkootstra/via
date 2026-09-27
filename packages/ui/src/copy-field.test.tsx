import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CopyField } from "./index.ts";

const key = "via-4f1c2b9e0d7a";

describe("CopyField", () => {
  it("is a button named by its label and described by the value", () => {
    render(<CopyField label="API key" value={key} />);

    const button = screen.getByRole("button", { name: "Copy API key" });
    const describedBy = button.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(key);
  });

  it("copies the value and says so", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(<CopyField label="API key" value={key} onCopy={onCopy} />);

    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    expect(await navigator.clipboard.readText()).toBe(key);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied"));
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("says so when the copy fails", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<CopyField label="API key" value={key} onCopy={onCopy} />);

    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copy failed"));
    expect(onCopy).not.toHaveBeenCalled();
  });
});
