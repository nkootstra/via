import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl, SegmentedItem } from "./index.ts";

function Hours({ onChange = () => {} }: { readonly onChange?: (value: string) => void }) {
  const [value, setValue] = useState("auto");

  return (
    <SegmentedControl
      aria-label="Time format"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    >
      <SegmentedItem value="auto" label="Automatic" />
      <SegmentedItem value="12h" label="12-hour" icon={<svg data-testid="icon" />} />
      <SegmentedItem value="24h" label="24-hour" />
    </SegmentedControl>
  );
}

const checked = (name: string) => screen.getByRole("radio", { name }).getAttribute("aria-checked");

describe("SegmentedControl", () => {
  it("is a named radio group, checking its value, each option named once", () => {
    render(<Hours />);

    expect(screen.getByRole("radiogroup", { name: "Time format" })).toBeDefined();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(checked("Automatic")).toBe("true");
    expect(checked("24-hour")).toBe("false");
  });

  it("chooses on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Hours onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "24-hour" }));

    expect(checked("24-hour")).toBe("true");
    expect(checked("Automatic")).toBe("false");
    expect(onChange).toHaveBeenLastCalledWith("24h");
  });

  it("is one tab stop, and the arrow keys choose", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Hours onChange={onChange} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Automatic" }));
    await user.keyboard("{ArrowRight}");

    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "12-hour" }));
    expect(checked("12-hour")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith("12h");
  });

  it("draws an option's icon, hidden from screen readers", () => {
    render(<Hours />);

    const icon = screen.getByTestId("icon");
    expect(screen.getByRole("radio", { name: "12-hour" }).contains(icon)).toBe(true);
    expect(icon.closest("[aria-hidden='true']")).not.toBeNull();
  });
});
