/**
 * RowActions: a table row's menu, behind a quiet icon button that opens it
 * lined up with the row's right edge. Pair it with an `actions` cell.
 */
import type { ReactNode } from "react";
import { Button } from "./button.tsx";
import { MoreIcon } from "./icons.tsx";
import { Menu, MenuContent, MenuTrigger } from "./menu.tsx";

export interface RowActionsProps {
  /** The trigger's accessible name, naming the row: "Actions for work". */
  readonly label: string;
  /** The menu's items: MenuItems and MenuSeparators. */
  readonly children: ReactNode;
}

export function RowActions({ label, children }: RowActionsProps) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost" size="icon-compact" aria-label={label}>
            <MoreIcon size={16} />
          </Button>
        }
      />
      <MenuContent align="end">{children}</MenuContent>
    </Menu>
  );
}
