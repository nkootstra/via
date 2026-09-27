import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./index.ts";

describe("Button", () => {
  it("is a focusable button named by its label that activates from the keyboard", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add account</Button>);

    const button = screen.getByRole("button", { name: "Add account" });
    await user.tab();
    expect(button).toBe(document.activeElement);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("is disabled and busy while loading, and keeps its name", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("names an icon-only button through its label", () => {
    render(
      <Button size="icon" aria-label="Close">
        <svg aria-hidden="true" />
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });

  it("draws a destructive action in its own variants, still named by its label", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button variant="destructive" onClick={onClick}>
          Revoke key
        </Button>
        <Button variant="ghost-destructive" aria-label="Sign out">
          <svg aria-hidden="true" />
        </Button>
      </>,
    );

    const revoke = screen.getByRole("button", { name: "Revoke key" });
    expect(revoke.getAttribute("data-variant")).toBe("destructive");
    expect(screen.getByRole("button", { name: "Sign out" }).getAttribute("data-variant")).toBe(
      "ghost-destructive",
    );
    await user.click(revoke);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
