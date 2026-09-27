import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Meter } from "./index.ts";

describe("Meter", () => {
  it("is a meter named by its label, reading out the percentage used", () => {
    render(<Meter label="5 hours" value={42.4} detail="Resets at 14:05" />);

    const meter = screen.getByRole("meter", { name: "5 hours" });
    expect(meter.getAttribute("aria-valuenow")).toBe("42.4");
    expect(meter.getAttribute("aria-valuetext")).toBe("42%");
    expect(screen.getByText("Resets at 14:05")).toBeDefined();
  });

  it("keeps a value past the limit at 100%", () => {
    render(<Meter label="7 days" value={130} />);

    expect(screen.getByRole("meter", { name: "7 days" }).getAttribute("aria-valuenow")).toBe("100");
  });
});
