import * as stylex from "@stylexjs/stylex";
import type { HistoryGroup } from "../api/types.ts";
import { formatUsd } from "../lib/usage-format.ts";

const styles = stylex.create({
  number: {
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
    whiteSpace: "nowrap",
  },
});

/**
 * What some usage cost: at API prices plus what was billed. As the Overview
 * has it, a model without a price costs an unknown amount, not nothing.
 */
export function CostAmount({ cost }: { readonly cost: HistoryGroup["cost"] }) {
  return cost.unpriced.length > 0 ? (
    <span title={`No price known for ${cost.unpriced.join(", ")}`} {...stylex.props(styles.number)}>
      Unknown
    </span>
  ) : (
    <span {...stylex.props(styles.number)}>
      {formatUsd(cost.apiEquivalentUsd + cost.billedUsd)}
    </span>
  );
}
