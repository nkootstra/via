import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./index.ts";

function Accounts() {
  return (
    <Table aria-label="Accounts">
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {["work", "home"].map((label, index) => (
          <TableRow key={label} index={index}>
            <TableCell>{label}</TableCell>
            <TableCell>available</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

describe("Table", () => {
  it("is a native table with column headers and one row per item", () => {
    render(<Accounts />);

    const table = screen.getByRole("table", { name: "Accounts" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Label", "State"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("cell", { name: "home" })).toBeDefined();
  });

  it("keeps the hover highlight out of the table's content", () => {
    render(<Accounts />);
    const table = screen.getByRole("table");

    fireEvent.pointerMove(table, { clientX: 10, clientY: 10 });

    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(table.parentElement?.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});
