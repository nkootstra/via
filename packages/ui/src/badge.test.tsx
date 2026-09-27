import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./index.ts";

describe("Badge", () => {
  it("reads as its label", () => {
    render(<Badge color="green">Available</Badge>);

    expect(screen.getByText("Available")).toBeDefined();
  });

  it("keeps the dot variant's dot out of the accessible text", () => {
    const { container } = render(
      <Badge variant="dot" color="amber">
        Cooling
      </Badge>,
    );

    const badge = container.firstElementChild;
    expect(badge?.textContent).toBe("Cooling");
    expect(badge?.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});
