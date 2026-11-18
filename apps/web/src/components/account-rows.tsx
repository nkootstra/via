import { useQueryClient } from "@tanstack/react-query";
import { MenuItem, MenuSeparator, RowActions, Switch, TableCell } from "@via/ui";
import type { ReactNode } from "react";
import { refreshPool } from "../api/admin.ts";
import { useMask } from "../lib/privacy.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { Day } from "./day.tsx";
import type { useEnabledToggle } from "./enabled-toggle.ts";
import { EditIcon, TrashIcon } from "./icons.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import type { RowDialogProps } from "./row-dialog.ts";

/** An account via pools, as its table shows it, whichever provider it is of. */
interface PooledAccount {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

/**
 * The cells every pooled account's row ends with: whether it is enabled, when it
 * was added, and its menu to rename or remove it.
 */
export function AccountRowEnd<Row extends PooledAccount>({
  account,
  enabled,
  onRename,
  onRemove,
}: {
  readonly account: Row;
  readonly enabled: ReturnType<typeof useEnabledToggle<Row>>;
  readonly onRename: () => void;
  readonly onRemove: () => void;
}) {
  const mask = useMask();

  return (
    <>
      <TableCell>
        <Switch
          aria-label={`${mask.key(account.label)} enabled`}
          checked={enabled.isOn(account)}
          aria-busy={enabled.busy(account.id)}
          onCheckedChange={() => enabled.toggle(account)}
        />
      </TableCell>
      <TableCell secondary>
        <Day at={account.createdAt} />
      </TableCell>
      <TableCell actions>
        <RowActions label={`Actions for ${mask.key(account.label)}`}>
          <MenuItem label="Rename…" icon={<EditIcon size={15} />} onClick={onRename} />
          <MenuSeparator />
          <MenuItem label="Remove…" icon={<TrashIcon size={15} />} destructive onClick={onRemove} />
        </RowActions>
      </TableCell>
    </>
  );
}

/**
 * A pooled account's rename and remove dialogs, whichever is open; each refreshes the
 * pool once it is done. `removeDescription` says what removing this account forgets.
 */
export function AccountDialogs<Row extends PooledAccount>({
  rename,
  remove,
  renameAccount,
  removeAccount,
  removeDescription,
}: {
  readonly rename: RowDialogProps<Row> | undefined;
  readonly remove: RowDialogProps<Row> | undefined;
  readonly renameAccount: (id: string, label: string) => Promise<string | undefined>;
  readonly removeAccount: (id: string) => Promise<void>;
  readonly removeDescription: (row: Row) => ReactNode;
}) {
  const mask = useMask();
  const queryClient = useQueryClient();

  return (
    <>
      {rename !== undefined && (
        <RenameDialog
          key={rename.row.id}
          {...rename}
          thing="Account"
          name={rename.row.label}
          hide={mask.key}
          field="Label"
          description="The label shows in usage, in the pool and in logs."
          rename={(label) => renameAccount(rename.row.id, label)}
          onRenamed={() => refreshPool(queryClient)}
        />
      )}
      {remove !== undefined && (
        <ConfirmDialog
          key={remove.row.id}
          {...remove}
          title={`Remove ${mask.key(remove.row.label)}?`}
          description={removeDescription(remove.row)}
          confirmLabel="Remove account"
          confirm={() => removeAccount(remove.row.id)}
          onConfirmed={() => refreshPool(queryClient)}
          done={{
            title: "Account removed",
            description: `via no longer uses ${mask.key(remove.row.label)}.`,
          }}
          failed={`Couldn't remove ${mask.key(remove.row.label)}`}
        />
      )}
    </>
  );
}
