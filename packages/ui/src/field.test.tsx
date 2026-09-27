import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Field, Input } from "./index.ts";

describe("Field", () => {
  it("names its input by the label and passes typing through", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Field label="Label">
        <Input onValueChange={onValueChange} />
      </Field>,
    );

    const input = screen.getByLabelText("Label");
    await user.type(input, "work");
    expect(input).toHaveProperty("value", "work");
    expect(onValueChange).toHaveBeenLastCalledWith("work", expect.anything());
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("marks the input invalid and describes it with the error", () => {
    render(
      <Field label="Admin key" error="That key is wrong">
        <Input type="password" />
      </Field>,
    );

    const input = screen.getByLabelText("Admin key");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";

    const descriptions = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);

    expect(descriptions).toContain("That key is wrong");
  });

  it("disables its input", () => {
    render(
      <Field label="Label" disabled>
        <Input />
      </Field>,
    );

    expect(screen.getByLabelText("Label")).toHaveProperty("disabled", true);
  });
});

describe("Input adornments", () => {
  it("draws a leading adornment inside the field, beside the input", () => {
    render(
      <Input
        type="search"
        aria-label="Search models"
        leading={<span data-testid="icon">⌕</span>}
      />,
    );

    const input = screen.getByRole("searchbox", { name: "Search models" });
    // One field: the input and its adornment share the box that draws it.
    expect(input.parentElement?.contains(screen.getByTestId("icon"))).toBe(true);
  });

  it("keeps the name its Field label gives it, beside a trailing action", () => {
    render(
      <Field label="Admin key">
        <Input type="password" trailing={<button type="button">Show key</button>} />
      </Field>,
    );

    const input = screen.getByLabelText("Admin key");
    expect(input.tagName).toBe("INPUT");
    expect(input.parentElement?.contains(screen.getByRole("button", { name: "Show key" }))).toBe(
      true,
    );
  });

  it("focuses the input when its leading adornment is clicked", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Search models" leading={<span data-testid="icon">⌕</span>} />);

    await user.click(screen.getByTestId("icon"));

    expect(document.activeElement).toBe(screen.getByLabelText("Search models"));
  });
});
