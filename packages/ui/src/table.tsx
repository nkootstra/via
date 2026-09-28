/**
 * Table, ported from Fluid Functionalism's table (MIT, see NOTICE): a native
 * table whose body rows share one gliding hover highlight. The lit row's
 * text turns to the foreground colour and the rules either side of it fade,
 * so the highlight reads as one band. The band is rounded like an item, so
 * in a flush panel (4px inset, 12px corners) it sits concentric with the
 * panel's corners instead of cutting across them.
 */
import * as stylex from "@stylexjs/stylex";
import { createContext, use, type ComponentProps } from "react";
import { FluidHighlight, useFluidHover } from "./fluid-hover.tsx";
import { colors, durations, radii, space, text, fontWeights, weights } from "./tokens.stylex.ts";
import { VisuallyHidden } from "./visually-hidden.tsx";

const styles = stylex.create({
  container: { position: "relative" },
  table: {
    position: "relative",
    width: "100%",
    borderCollapse: "collapse",
    fontSize: text.body,
  },
  fixed: { tableLayout: "fixed" },
  highlight: { borderRadius: radii.item },
  row: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: `color-mix(in srgb, ${colors.accent} 40%, transparent)`,
    transitionProperty: "border-color",
    transitionDuration: durations.fast,
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
  },
  // The last row's rule would double the edge of the panel the table sits in.
  bodyRow: {
    borderBottomColor: {
      default: `color-mix(in srgb, ${colors.accent} 40%, transparent)`,
      ":last-child": "transparent",
    },
  },
  headerRow: { fontVariationSettings: weights.semibold, fontWeight: fontWeights.semibold },
  ruleHidden: { borderBottomColor: "transparent" },
  head: {
    paddingBlock: space.s2,
    paddingInline: space.s3,
    textAlign: "start",
    fontWeight: "inherit",
    color: colors.foreground,
  },
  // One unbreakable value would otherwise widen the table, or in a fixed
  // layout draw over its neighbours; a caller that wants it cut short says so.
  cell: {
    paddingBlock: space.s2,
    paddingInline: space.s3,
    overflowWrap: "anywhere",
    color: colors.mutedForeground,
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  cellActive: { color: colors.foreground },
  secondary: {
    display: { default: "none", "@media (min-width: 640px)": "table-cell" },
  },
  secondaryColumn: {
    display: { default: "none", "@media (min-width: 640px)": "table-column" },
  },
  // Shrinks to its content in an automatic layout, and keeps it at the end.
  actions: {
    width: "1%",
    textAlign: "end",
    whiteSpace: "nowrap",
  },
  actionsContent: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.s1,
  },
});

/**
 * The width of an actions column in a fixed layout: a compact icon button
 * and the cell's padding either side.
 */
export const actionsColumn = "52px";

interface ColumnProps {
  /** A column narrow screens can do without: hidden below 640px, so the rest fit. */
  readonly secondary?: boolean;
  /** The row's actions, such as a RowActions: as narrow as they are, at the right edge. */
  readonly actions?: boolean;
}

interface TableState {
  readonly register: (index: number) => (element: HTMLElement | null) => void;
  readonly activeIndex: number | null;
}

const TableContext = createContext<TableState>({ register: () => () => {}, activeIndex: null });

const RowContext = createContext(false);

/** A column's width, or its width and whether narrow screens drop it with its cells. */
export type TableColumn = string | { readonly width: string; readonly secondary?: boolean };

export type TableProps = Omit<ComponentProps<"table">, "className" | "style"> & {
  /**
   * Each column's width, fixing the layout to them instead of the content, so
   * separate tables that share the same widths line up. An actions column
   * takes `actionsColumn`; a secondary column's width goes with its cells
   * below 640px.
   */
  readonly columns?: ReadonlyArray<TableColumn>;
};

const hasOptions = (column: TableColumn): column is Exclude<TableColumn, string> =>
  Object.hasOwn(Object(column), "width");

/** A column as its width and whether it is secondary. */
export const columnOf = (column: TableColumn) =>
  hasOptions(column) ? column : { width: column, secondary: false };

export function Table({ columns, children, ...props }: TableProps) {
  const { containerRef, register, active, handlers } = useFluidHover<HTMLDivElement, number>("y");
  const state = { register, activeIndex: active?.key ?? null };

  return (
    <TableContext value={state}>
      <div ref={containerRef} {...handlers} {...stylex.props(styles.container)}>
        <FluidHighlight rect={active?.rect ?? null} xstyle={styles.highlight} />
        <table {...props} {...stylex.props(styles.table, columns !== undefined && styles.fixed)}>
          {columns !== undefined && (
            <colgroup>
              {columns.map(columnOf).map(({ width, secondary = false }, index) => (
                // The widths are the caller's data, so they are set per element, not
                // as StyleX rules; React writes them through the DOM, which the CSP allows.
                <col
                  key={index}
                  data-secondary={secondary ? "" : undefined}
                  style={{ width }}
                  {...stylex.props(secondary && styles.secondaryColumn)}
                />
              ))}
            </colgroup>
          )}
          {children}
        </table>
      </div>
    </TableContext>
  );
}

type SectionProps = Omit<ComponentProps<"thead">, "className" | "style">;

export function TableHeader(props: SectionProps) {
  return <thead {...props} />;
}

export function TableBody(props: SectionProps) {
  return <tbody {...props} />;
}

export interface TableRowProps extends Omit<ComponentProps<"tr">, "className" | "style"> {
  /** A body row's position, which makes it a hover target. Header rows have none. */
  readonly index?: number;
}

export function TableRow({ index, ...props }: TableRowProps) {
  const { register, activeIndex } = use(TableContext);
  const header = index === undefined;
  const active = !header && index === activeIndex;

  // The lit row's own rule and the one above it both fade; a header's rule
  // fades when the first row is lit.
  const ruleHidden =
    activeIndex !== null &&
    (header ? activeIndex === 0 : index === activeIndex || index === activeIndex - 1);

  return (
    <RowContext value={active}>
      <tr
        {...props}
        ref={header ? undefined : register(index)}
        {...stylex.props(
          styles.row,
          header ? styles.headerRow : styles.bodyRow,
          ruleHidden && styles.ruleHidden,
        )}
      />
    </RowContext>
  );
}

export function TableHead({
  secondary = false,
  actions = false,
  children,
  ...props
}: Omit<ComponentProps<"th">, "className" | "style"> & ColumnProps) {
  return (
    <th
      {...props}
      data-secondary={secondary ? "" : undefined}
      data-actions={actions ? "" : undefined}
      {...stylex.props(styles.head, secondary && styles.secondary, actions && styles.actions)}
    >
      {/* An actions column shows no heading, but a screen reader still names it. */}
      {actions && children === undefined ? <VisuallyHidden>Actions</VisuallyHidden> : children}
    </th>
  );
}

export function TableCell({
  secondary = false,
  actions = false,
  children,
  ...props
}: Omit<ComponentProps<"td">, "className" | "style"> & ColumnProps) {
  const active = use(RowContext);

  return (
    <td
      {...props}
      data-secondary={secondary ? "" : undefined}
      data-actions={actions ? "" : undefined}
      {...stylex.props(
        styles.cell,
        active && styles.cellActive,
        secondary && styles.secondary,
        actions && styles.actions,
      )}
    >
      {actions ? <div {...stylex.props(styles.actionsContent)}>{children}</div> : children}
    </td>
  );
}
