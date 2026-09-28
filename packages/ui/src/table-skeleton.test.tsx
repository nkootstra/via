import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TableSkeleton } from "./index.ts";

describe("TableSkeleton", () => {
  it("announces the loading, and stands in rows the loaded table's shape", () => {
    const { container } = render(
      <TableSkeleton rows={3} columns={["40%", "60%"]} label="Loading keys" />,
    );

    expect(screen.getByRole("status").textContent).toBe("Loading keys");
    expect(screen.queryByRole("table")).toBeNull();
    const rows = container.querySelectorAll("tr");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelectorAll("td")).toHaveLength(2);
    expect([...container.querySelectorAll("col")].map((col) => col.style.width)).toEqual([
      "40%",
      "60%",
    ]);
  });

  it("takes a column count when the table sizes to its content", () => {
    const { container } = render(<TableSkeleton rows={2} columns={4} label="Loading accounts" />);

    expect(container.querySelectorAll("tr")[1]?.querySelectorAll("td")).toHaveLength(4);
    expect(container.querySelector("col")).toBeNull();
  });

  it("marks the columns narrow screens drop, as the loaded table does", () => {
    const { container } = render(
      <TableSkeleton rows={1} columns={3} secondary={[1]} label="Loading keys" />,
    );

    const cells = [...container.querySelectorAll("td")];
    expect(cells.map((cell) => cell.hasAttribute("data-secondary"))).toEqual([false, true, false]);
  });

  it("takes the loaded table's columns as they are, secondary ones included", () => {
    const { container } = render(
      <TableSkeleton
        rows={1}
        columns={["50%", { width: "50%", secondary: true }]}
        label="Loading keys"
      />,
    );

    const cells = [...container.querySelectorAll("td")];
    expect(cells.map((cell) => cell.hasAttribute("data-secondary"))).toEqual([false, true]);
  });
});
