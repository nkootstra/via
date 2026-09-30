import * as stylex from "@stylexjs/stylex";
import { accountColumns } from "./account-columns.ts";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  EmptyState,
  MenuItem,
  MenuSeparator,
  RowActions,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@via/ui";
import { colors, fonts, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { opencodeGoQuery, refreshPool, removeOpencodeGo, updateOpencodeGo } from "../api/admin.ts";
import { useLiveOptions } from "../api/live.ts";
import type { OpencodeGoAccount } from "../api/types.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { Day } from "./day.tsx";
import { useEnabledToggle } from "./enabled-toggle.ts";
import { ProviderLogo, EditIcon, TrashIcon } from "./icons.tsx";
import { Panel } from "./page.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { useRowDialog } from "./row-dialog.ts";
import { useMask } from "../lib/privacy.ts";

const styles = stylex.create({
  scroll: { overflowX: "auto" },
  who: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: 0,
  },
  // A long label ends in an ellipsis; its title holds all of it.
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  note: {
    maxWidth: "46ch",
    // The variable's name is one long word; it breaks rather than widen the cell.
    overflowWrap: "anywhere",
    fontSize: text.caption,
    lineHeight: 1.45,
    color: colors.mutedForeground,
  },
  key: {
    fontFamily: fonts.mono,
    whiteSpace: "nowrap",
  },
});

/**
 * The OpenCode Go accounts via pools, as a table: each one's label, its key's
 * last four characters, whether it is enabled and when it was added, with
 * renaming and removing it.
 */
export function OpencodeGoAccounts() {
  const mask = useMask();
  const queryClient = useQueryClient();
  const accounts = useSuspenseQuery({ ...opencodeGoQuery, ...useLiveOptions() });
  const dialogs = useRowDialog<OpencodeGoAccount, "rename" | "remove">();
  const enabled = useEnabledToggle(opencodeGoQuery.queryKey, updateOpencodeGo);
  const rename = dialogs.propsFor("rename");
  const remove = dialogs.propsFor("remove");

  // The dialogs sit outside the table, so removing the last account doesn't cut
  // its dialog's exit short.
  const body =
    accounts.data.length === 0 ? (
      <EmptyState
        icon={<ProviderLogo name="opencode-go" size={18} />}
        compact
        title="No OpenCode Go accounts yet"
        description="Add one with its OpenCode Go API key, and via pools it next to your others."
      />
    ) : (
      <Panel flush>
        <div {...stylex.props(styles.scroll)}>
          <Table aria-label="OpenCode Go accounts" columns={accountColumns}>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead secondary>Key</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead secondary>Added</TableHead>
                <TableHead actions />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.data.map((account, index) => (
                <TableRow key={account.id} index={index}>
                  <TableCell>
                    <div {...stylex.props(styles.who)}>
                      <span title={mask.key(account.label)} {...stylex.props(styles.label)}>
                        {mask.key(account.label)}
                      </span>
                      {account.environmentVariable !== undefined && (
                        <span {...stylex.props(styles.note)}>
                          Imported from {account.environmentVariable}, which is deprecated. Remove
                          the variable; via keeps this account.
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell secondary>
                    <span {...stylex.props(styles.key)}>{mask.key(account.key)}</span>
                  </TableCell>
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
                      <MenuItem
                        label="Rename…"
                        icon={<EditIcon size={15} />}
                        onClick={() => dialogs.show("rename", account)}
                      />
                      <MenuSeparator />
                      <MenuItem
                        label="Remove…"
                        icon={<TrashIcon size={15} />}
                        destructive
                        onClick={() => dialogs.show("remove", account)}
                      />
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
    );

  return (
    <>
      {body}
      {rename !== undefined && (
        <RenameDialog
          key={rename.row.id}
          {...rename}
          thing="Account"
          name={mask.key(rename.row.label)}
          field="Label"
          description="The label shows in usage, in the pool and in logs."
          rename={async (label) => {
            await updateOpencodeGo(rename.row.id, { label });
          }}
          onRenamed={() => refreshPool(queryClient)}
        />
      )}
      {remove !== undefined && (
        <ConfirmDialog
          key={remove.row.id}
          {...remove}
          title={`Remove ${mask.key(remove.row.label)}?`}
          description={
            <>
              via stops handing it out and forgets its key. You can add it again by pasting the key.
              {remove.row.environmentVariable !== undefined &&
                ` While ${remove.row.environmentVariable} is set, via adds it again when it restarts.`}
            </>
          }
          confirmLabel="Remove account"
          confirm={() => removeOpencodeGo(remove.row.id)}
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
