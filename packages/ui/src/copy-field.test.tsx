import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyField } from "./index.ts";

const key = "via-4f1c2b9e0d7a";

afterEach(() => vi.restoreAllMocks());

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

  it("conceals the value until shown, and copies it all the same", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<CopyField label="API key" value="via_secret123" concealed />);

    expect(document.body.innerHTML).not.toContain("via_secret123");
    await user.click(screen.getByRole("button", { name: "Copy API key" }));
    expect(writeText).toHaveBeenCalledWith("via_secret123");
    expect(document.body.innerHTML).not.toContain("via_secret123");

    await user.click(screen.getByRole("button", { name: "Show API key" }));
    expect(screen.getByText("via_secret123")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Show API key" })).toBeNull();
  });

  it("conceals the value again once it is to be concealed again", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CopyField label="API key" value="via_secret123" concealed />);
    await user.click(screen.getByRole("button", { name: "Show API key" }));

    rerender(<CopyField label="API key" value="via_secret123" concealed={false} />);
    rerender(<CopyField label="API key" value="via_secret123" concealed />);

    expect(document.body.innerHTML).not.toContain("via_secret123");
    expect(screen.getByRole("button", { name: "Show API key" })).toBeDefined();
  });

  it("says so when the copy fails", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<CopyField label="API key" value={key} onCopy={onCopy} />);

    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Couldn't copy. Select it and copy it by hand.",
      ),
    );
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("hands over the value to select and copy by hand when the clipboard fails", async () => {
    const user = userEvent.setup();

    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("insecure context"));

    render(<CopyField label="API key" value={key} />);
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    const manual = await screen.findByRole("textbox", { name: "API key, to copy by hand" });
    expect(manual).toHaveProperty("value", key);
    expect(manual.hasAttribute("readonly")).toBe(true);
    await user.click(manual);
    expect(document.activeElement).toBe(manual);

    // Once a copy goes through, it isn't needed any more.
    writeText.mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy API key" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("copies a large value the same way", async () => {
    const user = userEvent.setup();
    render(<CopyField label="Code" value="WXYZ-2345" size="large" />);

    await user.click(screen.getByRole("button", { name: "Copy Code" }));

    expect(await navigator.clipboard.readText()).toBe("WXYZ-2345");
  });
});

// Clicks, then lets the clipboard's promise settle.
const click = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Copy API key" }));
  await act(async () => {});
};

const status = () => screen.getByRole("status").textContent;

describe("CopyField's outcome", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  });

  afterEach(() => vi.useRealTimers());

  it("shows for two seconds, then the field is ready again", async () => {
    render(<CopyField label="API key" value={key} />);

    await click();
    expect(status()).toBe("Copied");
    act(() => vi.advanceTimersByTime(1999));
    expect(status()).toBe("Copied");
    act(() => vi.advanceTimersByTime(1));

    expect(status()).toBe("");
  });

  it("restarts the two seconds on another copy", async () => {
    render(<CopyField label="API key" value={key} />);

    await click();
    act(() => vi.advanceTimersByTime(1500));
    await click();
    act(() => vi.advanceTimersByTime(1500));
    expect(status()).toBe("Copied");
    act(() => vi.advanceTimersByTime(500));

    expect(status()).toBe("");
  });

  it("leaves no timer running once unmounted", async () => {
    const { unmount } = render(<CopyField label="API key" value={key} />);
    await click();

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
