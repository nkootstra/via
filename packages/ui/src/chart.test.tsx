import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BarChart, ChartTooltipContent, Stat, StatList } from "./index.ts";

const series = [
  { id: "gpt-6-astra", label: "gpt-6-astra" },
  { id: "kimi-k3", label: "kimi-k3" },
  { id: "other", label: "Other", other: true },
];

const points = [
  {
    x: 0,
    values: new Map([
      ["gpt-6-astra", 120],
      ["kimi-k3", 30],
    ]),
  },
  {
    x: 3_600_000,
    values: new Map([
      ["gpt-6-astra", 80],
      ["other", 5],
    ]),
  },
];

describe("BarChart", () => {
  it("is a figure named by its label, with a legend naming each series", () => {
    render(
      <BarChart
        label="Tokens per hour"
        points={points}
        series={series}
        formatX={(x) => `${x / 3_600_000}h`}
        formatValue={(value) => `${value} tokens`}
      />,
    );

    const figure = screen.getByRole("figure", { name: "Tokens per hour" });
    const legend = within(figure).getByRole("list", { name: "Series" });

    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["gpt-6-astra", "kimi-k3", "Other"]);
  });

  it("colours the series in order, and the rest grey", () => {
    render(<BarChart label="Tokens" points={points} series={series} />);

    const swatches = within(screen.getByRole("list", { name: "Series" }))
      .getAllByRole("listitem")
      .map((item) => item.querySelector("span")?.getAttribute("style"));

    expect(swatches).toEqual([
      "background-color: var(--via-chart-1);",
      "background-color: var(--via-chart-2);",
      "background-color: var(--via-chart-other);",
    ]);
  });

  it("draws the bars once it has room", async () => {
    // happy-dom lays nothing out, so every element measures 0 by 0 until given a size.
    const size = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ width: 600, height: 200 }));

    const { container } = render(
      <BarChart label="Tokens" points={points} series={series} height={200} />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBeGreaterThan(0),
    );

    size.mockRestore();
  });
});

describe("ChartTooltipContent", () => {
  it("lists the hovered bar's series, largest first, with their total", () => {
    render(
      <ChartTooltipContent
        active
        label={0}
        points={points}
        series={series}
        formatX={(x) => `hour ${x}`}
        formatValue={(value) => `${value} tokens`}
      />,
    );

    expect(screen.getByText("hour 0")).toBeDefined();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "gpt-6-astra120 tokens",
      "kimi-k330 tokens",
      "Total150 tokens",
    ]);
  });

  it("shows nothing while nothing is hovered", () => {
    const { container } = render(
      <ChartTooltipContent active={false} label={0} points={points} series={series} />,
    );

    expect(container.textContent).toBe("");
  });
});

describe("Stat", () => {
  it("names each figure in a description list", () => {
    render(
      <StatList>
        <Stat label="Requests" value="1,204" detail="12 failed" />
        <Stat label="Cache hit rate" value="41%" />
      </StatList>,
    );

    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual([
      "Requests",
      "Cache hit rate",
    ]);

    expect(screen.getAllByRole("definition").map((value) => value.textContent)).toEqual([
      "1,20412 failed",
      "41%",
    ]);
  });
});
