import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tooltip } from "./index.ts";

describe("Tooltip", () => {
  it("shows its content while the pointer rests on what it explains", async () => {
    const user = userEvent.setup();

    render(
      <Tooltip content="Guessed from the conversation's opening">
        <button type="button">Guessed</button>
      </Tooltip>,
    );

    expect(screen.queryByText("Guessed from the conversation's opening")).toBeNull();

    await user.hover(screen.getByRole("button", { name: "Guessed" }));
    expect(await screen.findByText("Guessed from the conversation's opening")).toBeDefined();
  });

  it("shows its content while what it explains has keyboard focus", async () => {
    render(
      <Tooltip content="2.4 s">
        <button type="button">Turn 1</button>
      </Tooltip>,
    );

    act(() => screen.getByRole("button", { name: "Turn 1" }).focus());

    expect(await screen.findByText("2.4 s")).toBeDefined();
  });
});
