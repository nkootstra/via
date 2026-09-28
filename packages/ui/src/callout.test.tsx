import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Callout } from "./index.ts";

describe("Callout", () => {
  it("is a note by default", () => {
    render(<Callout tone="warning">Keys rotate at midnight.</Callout>);

    expect(screen.getByRole("note").textContent).toBe("Keys rotate at midnight.");
  });

  it("takes the caller's role, such as an alert for danger", () => {
    render(
      <Callout tone="danger" role="alert">
        The account was signed out.
      </Callout>,
    );

    expect(screen.getByRole("alert").textContent).toBe("The account was signed out.");
    expect(screen.queryByRole("note")).toBeNull();
  });
});
