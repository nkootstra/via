import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryError } from "../src/components/query-error.tsx";

describe("a failed query", () => {
  it("says what didn't load, then why, in the error's own words", () => {
    const message = "Can't reach via right now. Check that it's running, then try again.";
    render(<QueryError what="keys" error={new Error(message)} onRetry={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toBe(`Couldn't load keys. ${message}Try again`);
  });

  it("says how to fix it when what failed isn't an Error", () => {
    render(<QueryError what="keys" error="a string, thrown" onRetry={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't load keys. Check that via is running, then try again.Try again",
    );
  });

  it("tries again when asked", async () => {
    const onRetry = vi.fn();
    render(<QueryError what="keys" error={new Error("down")} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
