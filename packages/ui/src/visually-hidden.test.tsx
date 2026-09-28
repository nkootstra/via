import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, VisuallyHidden } from "./index.ts";

describe("VisuallyHidden", () => {
  it("still names what it sits in", () => {
    render(
      <Button size="icon">
        <svg aria-hidden="true" />
        <VisuallyHidden>Close</VisuallyHidden>
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });
});
