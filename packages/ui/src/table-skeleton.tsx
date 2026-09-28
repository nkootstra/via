/**
 * TableSkeleton: a table's stand-in while it loads. It draws real rows and
 * cells, so the loaded table lands in the same place, hidden from assistive
 * tech, and a status region announces the loading instead.
 */
import * as stylex from "@stylexjs/stylex";
import { Skeleton } from "./placeholders.tsx";
import { columnOf, Table, TableBody, TableCell, TableRow, type TableColumn } from "./table.tsx";
import { visuallyHidden } from "./visually-hidden.tsx";

export interface TableSkeletonProps {
  readonly rows: number;
  /** The loaded table's `columns`, or how many columns it has when it sizes to its content. */
  readonly columns: ReadonlyArray<TableColumn> | number;
  /**
   * The indexes of the loaded table's `secondary` columns, which narrow
   * screens drop too, when `columns` is a count.
   */
  readonly secondary?: ReadonlyArray<number>;
  /** What is loading, announced to screen readers: "Loading keys". */
  readonly label: string;
}

// `Array.isArray` alone doesn't narrow a readonly array out of a union.
const isWidths = (columns: TableSkeletonProps["columns"]): columns is ReadonlyArray<TableColumn> =>
  Array.isArray(columns);

export function TableSkeleton({ rows, columns, secondary = [], label }: TableSkeletonProps) {
  const widths = isWidths(columns) ? columns : undefined;
  const count = isWidths(columns) ? columns.length : columns;

  return (
    <div>
      <output aria-live="polite" {...stylex.props(visuallyHidden)}>
        {label}
      </output>
      <Table aria-hidden="true" {...(widths !== undefined && { columns: widths })}>
        <TableBody>
          {Array.from({ length: rows }, (_row, row) => (
            // No index: stand-in rows are no hover targets.
            <TableRow key={row}>
              {Array.from({ length: count }, (_column, column) => (
                <TableCell
                  key={column}
                  secondary={
                    secondary.includes(column) ||
                    (widths?.[column] !== undefined && columnOf(widths[column]).secondary === true)
                  }
                >
                  <Skeleton />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
