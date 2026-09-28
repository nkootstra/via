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

  it("keeps its thumb out of the tab order, as it is hidden", () => {
    render(<Enabled onChange={vi.fn()} />);

    const control = screen.getByRole("switch", { name: "Enabled" });
    const hidden = [...control.querySelectorAll("[aria-hidden='true']")];
    expect(hidden.length).toBeGreaterThan(0);

    for (const element of hidden) {
      expect(element.getAttribute("tabindex") ?? "-1").toBe("-1");
    }
  });

  it("says it is busy while its change saves, still enabled", () => {
    render(<Switch aria-label="Enabled" checked onCheckedChange={vi.fn()} aria-busy />);

    const control = screen.getByRole("switch", { name: "Enabled" });
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.hasAttribute("aria-disabled")).toBe(false);
  });
});
