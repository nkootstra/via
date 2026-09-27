/**
 * Table, ported from Fluid Functionalism's table (MIT, see NOTICE): a native
 * table whose body rows share one gliding hover highlight. The lit row's
 * text turns to the foreground colour and the rules either side of it fade,
 * so the highlight reads as one band.
 */
import * as stylex from "@stylexjs/stylex";
import { createContext, use, type ComponentProps } from "react";
import { FluidHighlight, useFluidHover } from "./fluid-hover.tsx";
import { colors, durations, space, text, weights } from "./tokens.stylex.ts";

const styles = stylex.create({
  container: { position: "relative" },
  table: {
    position: "relative",
    width: "100%",
    borderCollapse: "collapse",
    fontSize: text.body,
  },
  row: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: `color-mix(in srgb, ${colors.accent} 40%, transparent)`,
    transitionProperty: "border-color",
    transitionDuration: durations.fast,
    fontVariationSettings: weights.normal,
  },
  headerRow: { fontVariationSettings: weights.semibold },
  ruleHidden: { borderBottomColor: "transparent" },
  head: {
    paddingBlock: space.s2,
    paddingInline: space.s3,
    textAlign: "left",
    fontWeight: "inherit",
    color: colors.foreground,
  },
  cell: {
    paddingBlock: space.s2,
    paddingInline: space.s3,
    color: colors.mutedForeground,
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  cellActive: { color: colors.foreground },
});

interface TableState {
  readonly register: (index: number) => (element: HTMLElement | null) => void;
  readonly activeIndex: number | null;
}

const TableContext = createContext<TableState>({ register: () => () => {}, activeIndex: null });

const RowContext = createContext(false);

export type TableProps = Omit<ComponentProps<"table">, "className" | "style">;

export function Table(props: TableProps) {
  const { containerRef, register, active, handlers } = useFluidHover<HTMLDivElement>("y");
  const state = { register, activeIndex: active?.index ?? null };

  return (
    <TableContext value={state}>
      <div ref={containerRef} {...handlers} {...stylex.props(styles.container)}>
        <FluidHighlight rect={active?.rect ?? null} />
        <table {...props} {...stylex.props(styles.table)} />
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
        {...stylex.props(styles.row, header && styles.headerRow, ruleHidden && styles.ruleHidden)}
      />
    </RowContext>
  );
}

export function TableHead(props: Omit<ComponentProps<"th">, "className" | "style">) {
  return <th {...props} {...stylex.props(styles.head)} />;
}

export function TableCell(props: Omit<ComponentProps<"td">, "className" | "style">) {
  const active = use(RowContext);

  return <td {...props} {...stylex.props(styles.cell, active && styles.cellActive)} />;
}
