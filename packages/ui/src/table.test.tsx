import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  actionsColumn,
} from "./index.ts";

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
  it("marks a secondary column's header and cells, which narrow screens drop", () => {
    render(
      <Table aria-label="Keys">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead secondary>Id</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow index={0}>
            <TableCell>laptop</TableCell>
            <TableCell secondary>k1</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(screen.getByRole("columnheader", { name: "Id" }).hasAttribute("data-secondary")).toBe(
      true,
    );
    expect(screen.getByRole("cell", { name: "k1" }).hasAttribute("data-secondary")).toBe(true);
    expect(screen.getByRole("cell", { name: "laptop" }).hasAttribute("data-secondary")).toBe(false);
  });

  it("fixes its columns to given widths, so tables that share them line up", () => {
    render(
      <Table aria-label="Keys" columns={["40%", "60%"]}>
        <TableBody>
          <TableRow index={0}>
            <TableCell>laptop</TableCell>
            <TableCell>…abcd</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const table = screen.getByRole("table", { name: "Keys" });
    const widths = [...table.querySelectorAll("col")].map((col) => col.style.width);
    expect(widths).toEqual(["40%", "60%"]);
  });

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

  it("marks an actions column, whose header is named for screen readers alone", () => {
    render(
      <Table aria-label="Keys" columns={["100%", actionsColumn]}>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead actions />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow index={0}>
            <TableCell>laptop</TableCell>
            <TableCell actions>
              <Button size="icon-compact" aria-label="Revoke laptop" />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const header = screen.getByRole("columnheader", { name: "Actions" });
    expect(header.hasAttribute("data-actions")).toBe(true);
    expect(header.textContent).toBe("Actions");
    const cell = screen.getByRole("button", { name: "Revoke laptop" }).closest("td");
    expect(cell?.hasAttribute("data-actions")).toBe(true);
    expect(screen.getByRole("cell", { name: "laptop" }).hasAttribute("data-actions")).toBe(false);
    expect(actionsColumn).toMatch(/^\d+px$/);
  });

  it("keeps an actions header's own label when given one", () => {
    render(
      <Table aria-label="Keys">
        <TableHeader>
          <TableRow>
            <TableHead actions>Manage</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );

    expect(screen.getByRole("columnheader", { name: "Manage" })).toBeDefined();
  });

  it("drops a secondary column's width with it on narrow screens, in a fixed layout", () => {
    render(
      <Table aria-label="Keys" columns={["40%", { width: "30%", secondary: true }, "30%"]}>
        <TableBody>
          <TableRow index={0}>
            <TableCell>laptop</TableCell>
            <TableCell secondary>k1</TableCell>
            <TableCell>today</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const cols = [...screen.getByRole("table").querySelectorAll("col")];
    expect(cols.map((col) => col.style.width)).toEqual(["40%", "30%", "30%"]);
    expect(cols.map((col) => col.hasAttribute("data-secondary"))).toEqual([false, true, false]);
  });
});
