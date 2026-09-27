import * as stylex from "@stylexjs/stylex";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  Button,
  CopyField,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
  useToast,
} from "@via/ui";
import { colors, radii, space, text } from "@via/ui/tokens.stylex";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";
import { loginStatus, startLogin } from "../api/admin.ts";
import type { Account, StartedLogin } from "../api/types.ts";
import { ExternalIcon } from "./icons.tsx";

const styles = stylex.create({
  code: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: space.s3,
    paddingBlock: space.s4,
    paddingInline: space.s4,
    marginBottom: space.s4,
    borderRadius: radii.container,
    backgroundColor: colors.muted,
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    margin: 0,
    paddingLeft: "18px",
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  waiting: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    marginTop: space.s4,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  pulse: {
    width: "8px",
    height: "8px",
    borderRadius: radii.full,
    backgroundColor: "#3b82f6",
    animationName: stylex.keyframes({
      "0%, 100%": { opacity: 1, transform: "scale(1)" },
      "50%": { opacity: 0.35, transform: "scale(0.8)" },
    }),
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
  },
  error: {
    margin: 0,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderRadius: radii.item,
    fontSize: text.caption,
    lineHeight: 1.45,
    color: colors.foreground,
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 10%, transparent)`,
  },
  // A link dressed as the primary button: it opens OpenAI's page in a new tab.
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    height: space.control,
    paddingInline: space.s4,
    borderRadius: radii.item,
    fontSize: text.body,
    textDecoration: "none",
    whiteSpace: "nowrap",
    color: colors.background,
    backgroundColor: {
      default: colors.foreground,
      ":hover": `color-mix(in oklab, ${colors.foreground} 90%, ${colors.background})`,
    },
    outline: "none",
    boxShadow: {
      default: null,
      ":focus-visible": `0 0 0 1px ${colors.background}, 0 0 0 2px ${colors.focusRing}`,
    },
  },
});

/** A device-code login: the code to enter, then polling every 2 s until the account is added. */
function AddAccountDialog({
  start,
  onClose,
}: {
  readonly start: UseMutationResult<StartedLogin, Error, void>;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const login = start.data;

  const status = useQuery({
    queryKey: ["login", login?.id],
    queryFn: () => loginStatus(login?.id ?? ""),
    enabled: login !== undefined,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2_000 : false),
    gcTime: 0,
  });

  const outcome = status.data;

  const added = useEffectEvent((account: Account) => {
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["pool"] });
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
    toast.add({ title: "Account added", description: `${account.label} is in the pool.` });
    onClose();
  });

  useEffect(() => {
    if (outcome?.status === "added") added(outcome.account);
  }, [outcome]);

  const failed =
    outcome?.status === "failed" ? outcome.error : (start.error?.message ?? status.error?.message);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add a ChatGPT account</DialogTitle>
          <DialogDescription>
            Sign in to ChatGPT in another tab and enter this code. via adds the account as soon as
            you approve it.
          </DialogDescription>
        </DialogHeader>

        {failed !== undefined ? (
          <p role="alert" {...stylex.props(styles.error)}>
            The login didn't go through: {failed}
          </p>
        ) : login === undefined ? (
          <div {...stylex.props(styles.code)}>
            <Skeleton width="60%" height="36px" />
            <Skeleton width="80%" height="36px" />
          </div>
        ) : (
          <>
            <div {...stylex.props(styles.code)}>
              <CopyField label="Your code" value={login.userCode} size="large" />
            </div>
            <ol {...stylex.props(styles.steps)}>
              <li>Open the sign-in page and log in to the ChatGPT account to add.</li>
              <li>Enter the code above and approve the request.</li>
            </ol>
            <output {...stylex.props(styles.waiting)}>
              <span aria-hidden="true" {...stylex.props(styles.pulse)} />
              Waiting for you to approve…
            </output>
          </>
        )}

        <DialogFooter>
          <DialogClose
            render={<Button variant="tertiary">{failed === undefined ? "Cancel" : "Close"}</Button>}
          />
          {failed !== undefined ? (
            <Button onClick={() => start.mutate()} loading={start.isPending}>
              Try again
            </Button>
          ) : (
            login !== undefined && (
              <a
                href={login.verificationUrl}
                target="_blank"
                rel="noreferrer"
                {...stylex.props(styles.link)}
              >
                Open sign-in page
                <ExternalIcon size={14} />
              </a>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Adding a ChatGPT account, in place on whichever page asks: `open` starts a
 * device-code login and shows its dialog, which `dialog` renders. Once the
 * account is added, the pool, its usage and the accounts are fetched again.
 */
export function useAddAccount() {
  const [shown, setShown] = useState(false);
  const start = useMutation({ mutationFn: startLogin });

  return {
    open: () => {
      start.mutate();
      setShown(true);
    },
    dialog: (shown && (
      <AddAccountDialog start={start} onClose={() => setShown(false)} />
    )) satisfies ReactNode,
  };
}
