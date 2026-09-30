import * as stylex from "@stylexjs/stylex";
import { accountColumns } from "../../components/account-columns.ts";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
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
  TableSkeleton,
} from "@via/ui";
import { colors, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import {
  accountsQuery,
  ollamaQuery,
  opencodeGoQuery,
  refreshPool,
  removeAccount,
  updateAccount,
} from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import type { Account } from "../../api/types.ts";
import { useAddAccount } from "../../components/add-account.tsx";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { Day } from "../../components/day.tsx";
import { useEnabledToggle } from "../../components/enabled-toggle.ts";
import {
  AccountsIcon,
  CodexIcon,
  PlusIcon,
  ProviderLogo,
  EditIcon,
  TrashIcon,
} from "../../components/icons.tsx";
import { OllamaSection } from "../../components/ollama.tsx";
import { OpencodeGoAccounts } from "../../components/opencode-go-accounts.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";
import { QueryError } from "../../components/query-error.tsx";
import { RenameDialog } from "../../components/rename-dialog.tsx";
import { useRowDialog } from "../../components/row-dialog.ts";

export const Route = createFileRoute("/_app/accounts")({
  head: () => ({ meta: [{ title: "Accounts · via" }] }),
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(accountsQuery),
      queryClient.ensureQueryData(opencodeGoQuery),
      queryClient.ensureQueryData(ollamaQuery),
    ]),
  pendingComponent: AccountsLoading,
  errorComponent: AccountsError,
  component: Accounts,
});

const styles = stylex.create({
  scroll: { overflowX: "auto" },
  who: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: 0,
  },
  // A long label or email ends in an ellipsis; its title holds all of it.
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  label: {
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  email: {
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
});

const title = "Accounts";

const description =
  "The ChatGPT and OpenCode Go accounts via pools, and the Ollama it sends local models to. Disable an account to keep it out of rotation without losing it.";

/** The page while its data is on its way, which only a page without the shell's state waits for. */
function AccountsLoading() {
  return (
    <Page title={title} description={description}>
      <Section title="ChatGPT (Codex)" icon={<CodexIcon size={16} />}>
        <Panel flush>
          <TableSkeleton rows={3} columns={accountColumns} label="Loading accounts" />
        </Panel>
      </Section>
    </Page>
  );
}

function Accounts() {
  const queryClient = useQueryClient();
  const accounts = useSuspenseQuery({ ...accountsQuery, ...useLiveOptions() });
  const dialogs = useRowDialog<Account, "rename" | "remove">();
  const add = useAddAccount();
  const enabled = useEnabledToggle(accountsQuery.queryKey, updateAccount);
  const rename = dialogs.propsFor("rename");
  const remove = dialogs.propsFor("remove");

  return (
    <Page
      title={title}
      description={description}
      actions={
        <Button onClick={add.open}>
          <PlusIcon size={15} />
          Add account
        </Button>
      }
    >
      <Section title="ChatGPT (Codex)" icon={<CodexIcon size={16} />}>
        {accounts.data.length === 0 ? (
          <EmptyState
            icon={<AccountsIcon size={18} />}
            compact
            title="No accounts yet"
            description="Add a ChatGPT account with a device login. via keeps its tokens fresh from then on."
          />
        ) : (
          <Panel flush>
            <div {...stylex.props(styles.scroll)}>
              <Table aria-label="ChatGPT accounts" columns={accountColumns}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead secondary>Plan</TableHead>
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
                          <span
                            title={account.label}
                            {...stylex.props(styles.label, styles.truncate)}
                          >
                            {account.label}
                          </span>
                          <span
                            title={account.email}
                            {...stylex.props(styles.email, styles.truncate)}
                          >
                            {account.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell secondary>
                        <Badge>{account.plan}</Badge>
                      </TableCell>
                      <TableCell>
                        <Switch
                          aria-label={`${account.label} enabled`}
                          checked={enabled.isOn(account)}
                          aria-busy={enabled.busy(account.id)}
                          onCheckedChange={() => enabled.toggle(account)}
                        />
                      </TableCell>
                      <TableCell secondary>
                        <Day at={account.createdAt} />
                      </TableCell>
                      <TableCell actions>
                        <RowActions label={`Actions for ${account.label}`}>
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
        )}
      </Section>

      <Section title="OpenCode Go" icon={<ProviderLogo name="opencode-go" size={16} />}>
        <OpencodeGoAccounts />
      </Section>

      <Section title="Ollama" icon={<ProviderLogo name="ollama" size={16} />}>
        <OllamaSection />
      </Section>

      {add.dialog}
      {rename !== undefined && (
        <RenameDialog
          key={rename.row.id}
          {...rename}
          thing="Account"
          name={rename.row.label}
          field="Label"
          description="The label shows in usage, in the pool and in logs."
          rename={async (label) => {
            await updateAccount(rename.row.id, { label });
          }}
          onRenamed={() => refreshPool(queryClient)}
        />
      )}
      {remove !== undefined && (
        <ConfirmDialog
          key={remove.row.id}
          {...remove}
          title={`Remove ${remove.row.label}?`}
          description="via stops handing it out and forgets its tokens. You can add it again by signing in."
          confirmLabel="Remove account"
          confirm={() => removeAccount(remove.row.id)}
          onConfirmed={() => refreshPool(queryClient)}
          done={{
            title: "Account removed",
            description: `via no longer uses ${remove.row.label}.`,
          }}
          failed={`Couldn't remove ${remove.row.label}`}
        />
      )}
    </Page>
  );
}

/** The page when its data couldn't be loaded: its header stays, and it can try again. */
function AccountsError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <Page title={title} description={description}>
      <QueryError
        what="accounts"
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </Page>
  );
}
