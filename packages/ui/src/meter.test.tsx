import { render, screen, waitFor } from "@testing-library/react";
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

  it("fills the bar no further than the limit, but says how far past it the value is", () => {
    render(<Meter label="7 days" value={149.6} />);

    const meter = screen.getByRole("meter", { name: "7 days" });
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(meter.getAttribute("aria-valuetext")).toBe("150%");
    expect(screen.getByText("150%")).toBeDefined();
  });

  it("offers a label cut short in full on hover", () => {
    render(<Meter label="A very long limit name that runs out of room" value={10} />);

    expect(
      screen.getByText("A very long limit name that runs out of room").getAttribute("title"),
    ).toBe("A very long limit name that runs out of room");
  });

  it("slides a full-width fill in from the left rather than squashing it", async () => {
    render(<Meter label="5 hours" value={30} />);

    const fill = screen.getByRole("meter").querySelector(":scope > div > span");
    await waitFor(() => expect(fill?.getAttribute("style")).toContain("translateX(-70%)"));
  });
});
