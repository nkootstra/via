import { actionsColumn } from "@via/ui";

/**
 * The column widths every accounts table shares (account, detail, enabled, added,
 * actions), so the Codex and OpenCode Go tables line up on the Accounts page.
 * The account column takes no width: in a fixed layout it gets what the others
 * leave, so the actions column's pixels come out of it rather than widening
 * the table past its panel. Narrow screens drop the detail and Added, and the
 * account column takes their share.
 */
export const accountColumns = [
  "auto",
  { width: "18%", secondary: true },
  "14%",
  { width: "24%", secondary: true },
  actionsColumn,
] as const;
