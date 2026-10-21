import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import type { UsageRequest } from "../src/api/types.ts";
import { Waterfall } from "../src/components/waterfall.tsx";
import { timelineOf } from "../src/lib/timeline.ts";
import { attempt, request } from "../src/testing/history.ts";

const T0 = Date.parse("2026-09-27T11:30:00.000Z");

const turn = (requestId: string, at: number, fields: Partial<UsageRequest> = {}) =>
  request({
    requestId,
    at: T0 + at,
    durationMs: 2_000,
    firstChunkMs: Option.some(500),
    conversationId: Option.some("root"),
    ...fields,
  });

const sub = (
  requestId: string,
  at: number,
  agentType: string,
  fields: Partial<UsageRequest> = {},
) =>
  turn(requestId, at, {
    conversationId: Option.some("child"),
    parentConversationId: Option.some("root"),
    agentType: Option.some(agentType),
    ...fields,
  });

/** The row of turn `number`: its label, bar and, opened, its attempts. */
const rowOf = (number: number) =>
  screen.getByRole("button", { name: new RegExp(`^Turn ${number},`) }).closest("li");

/** What the row of turn `number` reads, its attempts aside. */
const labelOf = (number: number) => rowOf(number)?.firstElementChild?.textContent ?? "";

describe("Waterfall", () => {
  it("shows how long each turn took beside its bar", () => {
    render(
      <Waterfall
        timeline={timelineOf("root", [turn("a", 0), turn("b", 4_000, { durationMs: 1_700 })])}
      />,
    );

    expect(labelOf(1)).toContain("2.0 s");
    expect(labelOf(2)).toContain("1.7 s");
  });

  it("names a turn's model only where it changes from the row above", () => {
    render(
      <Waterfall
        timeline={timelineOf("root", [
          turn("a", 0),
          turn("b", 3_000),
          sub("s", 6_000, "explore"),
          turn("c", 9_000),
          turn("d", 12_000, { model: "opencode-go/kimi-k3" }),
        ])}
      />,
    );

    expect(labelOf(1)).toContain("gpt-6-astra");
    expect(labelOf(2)).not.toContain("gpt-6-astra");
    // The first row of a sub-agent, and the first after one, say it again.
    expect(labelOf(3)).toContain("gpt-6-astra");
    expect(labelOf(4)).toContain("gpt-6-astra");
    expect(labelOf(5)).toContain("kimi-k3");
  });

  it("says a turn's model is unknown when its request named none", () => {
    render(<Waterfall timeline={timelineOf("root", [turn("a", 0, { model: "" })])} />);

    expect(labelOf(1)).toContain("Unknown model");
    expect(screen.getByRole("button", { name: /^Turn 1,/ }).getAttribute("aria-label")).toContain(
      "Unknown model",
    );
  });

  it("names a sub-agent of no type plainly", () => {
    render(<Waterfall timeline={timelineOf("root", [turn("a", 0), sub("s", 3_000, "")])} />);

    const group = screen.getByRole("list", { name: "Sub-agent" });
    expect(group.previousElementSibling?.textContent).toContain("Sub-agent");
  });

  it("marks the axis at round steps", () => {
    render(<Waterfall timeline={timelineOf("root", [turn("a", 0), turn("b", 75_000)])} />);

    const axis = screen.getByTestId("axis");
    const labels = [...axis.querySelectorAll("span span")].map((tick) => tick.textContent);

    expect(labels).toEqual(["0", "15 s", "30 s", "45 s", "60 s", "75 s"]);
  });

  it("says in words what a turn's attempts were, failed or retried", async () => {
    const user = userEvent.setup();

    render(
      <Waterfall
        timeline={timelineOf("root", [turn("a", 0), turn("b", 3_000)], {
          attempts: [
            attempt({ requestId: "a", startedAt: T0, durationMs: 400, outcome: "failed" }),
            attempt({ requestId: "a", seq: 1, startedAt: T0 + 400, durationMs: 1_600 }),
            attempt({ requestId: "b", startedAt: T0 + 3_000, durationMs: 1_000 }),
            attempt({ requestId: "b", seq: 1, startedAt: T0 + 4_000, durationMs: 1_000 }),
          ],
        })}
      />,
    );

    const failed = screen.getByRole("button", { name: /^Attempts of turn 1\b/ });
    const retried = screen.getByRole("button", { name: /^Attempts of turn 2\b/ });

    expect(failed.getAttribute("aria-label")).toBe("Attempts of turn 1: 2, 1 failed");
    expect(failed.textContent).toContain("1 failed");
    expect(retried.textContent).toContain("2 attempts");

    await user.click(failed);
    const attempts = within(screen.getByRole("list", { name: "Attempts of turn 1" }));
    const [first] = attempts.getAllByRole("listitem");
    expect(first?.firstElementChild?.textContent).toContain("400 ms");
  });
});
