import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, EmptyState, Skeleton } from "./index.ts";

describe("Skeleton", () => {
  it("stays out of the accessibility tree", () => {
    const { container } = render(<Skeleton width="8rem" />);

    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("EmptyState", () => {
  it("is a region named by its heading, with its action", () => {
    render(
      <EmptyState
        title="No accounts yet"
        description="Add a ChatGPT account to start."
        action={<Button>Add account</Button>}
      />,
    );

    const region = screen.getByRole("region", { name: "No accounts yet" });
    expect(screen.getByRole("heading", { name: "No accounts yet" })).toBeDefined();
    expect(region.textContent).toContain("Add a ChatGPT account to start.");
    expect(screen.getByRole("button", { name: "Add account" })).toBeDefined();
  });
});
