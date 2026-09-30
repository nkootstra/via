import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterSelect, type FilterOption } from "./index.ts";

const models: ReadonlyArray<FilterOption> = [
  { value: "gpt-6-luna", label: "gpt-6-luna", detail: "42" },
  { value: "opencode-go/kimi-k3", label: "kimi-k3", detail: "7" },
  { value: "opencode-go/minimax-m3", label: "minimax-m3", detail: "3" },
];

function Controlled({
  onChange = () => {},
}: {
  readonly onChange?: (value: string | null) => void;
}) {
  const [value, setValue] = useState<string | null>(null);

  return (
    <FilterSelect
      label="Model"
      options={models}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("FilterSelect", () => {
  it("names its facet, and says so when nothing is chosen", () => {
    render(<Controlled />);

    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toBe("Model");
    expect(screen.queryByRole("button", { name: "Remove Model filter" })).toBeNull();
  });

  it("lists the options with their details, and narrows them as you type", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    const list = await screen.findByRole("listbox");

    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["gpt-6-luna42", "kimi-k37", "minimax-m33"]);

    await user.keyboard("kimi");

    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["kimi-k37"]),
    );
  });

  it("says when nothing matches what was typed", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await screen.findByRole("listbox");
    await user.keyboard("llama");

    expect(await screen.findByText("No matches")).toBeDefined();
  });

  it("chooses an option, shows it on the trigger, and removes it again", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /kimi-k3/ }));

    expect(onChange).toHaveBeenLastCalledWith("opencode-go/kimi-k3");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model: kimi-k3" })).toBeDefined(),
    );

    await user.click(screen.getByRole("button", { name: "Remove Model filter" }));

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDefined();
  });
});
