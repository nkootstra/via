import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./index.ts";

function Enabled({ onChange }: { readonly onChange: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(true);

  return (
    <Switch
      aria-label="Enabled"
      checked={checked}
      onCheckedChange={(next) => {
        setChecked(next);
        onChange(next);
      }}
    />
  );
}

describe("Switch", () => {
  it("is a named switch that toggles from a click or the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Enabled onChange={onChange} />);

    const control = screen.getByRole("switch", { name: "Enabled" });
    expect(control.getAttribute("aria-checked")).toBe("true");

    await user.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");

    await user.keyboard(" ");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(onChange.mock.calls).toEqual([[false], [true]]);
  });

  it("ignores input while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch aria-label="Enabled" checked={false} onCheckedChange={onChange} disabled />);

    await user.click(screen.getByRole("switch", { name: "Enabled" }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
