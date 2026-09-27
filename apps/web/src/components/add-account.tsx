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
  Field,
  Input,
  Skeleton,
  useToast,
} from "@via/ui";
import { colors, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";
import { addOpencodeGo, loginStatus, startLogin } from "../api/admin.ts";
import type { Account, StartedLogin } from "../api/types.ts";
import { CodexIcon, ExternalIcon, ProviderLogo } from "./icons.tsx";

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
  choices: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    marginBottom: space.s4,
  },
  // One kind of account to add: a whole-width button with a logo, a name and a line on how.
  choice: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    width: "100%",
    paddingBlock: space.s3,
    paddingInline: space.s3,
    borderWidth: 0,
    borderRadius: radii.item,
    textAlign: "left",
    cursor: "pointer",
    color: colors.foreground,
    backgroundColor: { default: colors.muted, ":hover": colors.border },
    outline: "none",
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.border}`,
      ":focus-visible": `0 0 0 2px ${colors.focusRing}`,
    },
  },
  choiceText: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
  },
  choiceName: {
    fontSize: text.body,
    fontVariationSettings: weights.semibold,
  },
  choiceHow: {
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
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

/** Which kind of account to add: a ChatGPT one, by device login, or an OpenCode Go key. */
function ChooseDialog({
  onCodex,
  onOpencodeGo,
  onClose,
}: {
  readonly onCodex: () => void;
  readonly onOpencodeGo: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an account</DialogTitle>
          <DialogDescription>via pools each kind of account on its own.</DialogDescription>
        </DialogHeader>
        <div {...stylex.props(styles.choices)}>
          <button type="button" onClick={onCodex} {...stylex.props(styles.choice)}>
            <CodexIcon size={18} />
            <span {...stylex.props(styles.choiceText)}>
              <span {...stylex.props(styles.choiceName)}>ChatGPT (Codex)</span>
              <span {...stylex.props(styles.choiceHow)}>Sign in with a device code.</span>
            </span>
          </button>
          <button type="button" onClick={onOpencodeGo} {...stylex.props(styles.choice)}>
            <ProviderLogo name="opencode-go" size={18} />
            <span {...stylex.props(styles.choiceText)}>
              <span {...stylex.props(styles.choiceName)}>OpenCode Go</span>
              <span {...stylex.props(styles.choiceHow)}>Paste an API key.</span>
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Pasting an OpenCode Go API key, which via checks with OpenCode Go before it keeps it. */
function OpencodeGoDialog({ onClose }: { readonly onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [apiKey, setApiKey] = useState("");

  const add = useMutation({
    mutationFn: () => addOpencodeGo(apiKey.trim()),
    onSuccess: (outcome) => {
      if (!outcome.added) return;
      void queryClient.invalidateQueries({ queryKey: ["opencode-go"] });
      void queryClient.invalidateQueries({ queryKey: ["pool"] });
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
      toast.add({ title: "Key added", description: `${outcome.label} is in the pool.` });
      onClose();
    },
  });

  const problem = add.data?.added === false ? add.data.problem : (add.error?.message ?? undefined);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add an OpenCode Go key</DialogTitle>
            <DialogDescription>
              Paste an API key from your OpenCode Go account. via checks it with OpenCode Go before
              adding it, and only ever shows its last four characters.
            </DialogDescription>
          </DialogHeader>
          <Field label="API key" error={problem}>
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onValueChange={(value) => {
                setApiKey(value);
                add.reset();
              }}
              required
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
            <Button type="submit" loading={add.isPending} disabled={apiKey.trim() === ""}>
              Add key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Adding an account, in place on whichever page asks: `open` asks which kind,
 * then starts a device-code login for a ChatGPT one, or takes an OpenCode Go
 * key, in the dialog `dialog` renders. Once the account is added, the pool,
 * its usage and the accounts are fetched again.
 */
export function useAddAccount() {
  const [shown, setShown] = useState<"choose" | "codex" | "opencode-go" | undefined>();
  const start = useMutation({ mutationFn: startLogin });
  const close = () => setShown(undefined);

  const dialogs = {
    choose: (
      <ChooseDialog
        onCodex={() => {
          start.mutate();
          setShown("codex");
        }}
        onOpencodeGo={() => setShown("opencode-go")}
        onClose={close}
      />
    ),
    codex: <AddAccountDialog start={start} onClose={close} />,
    "opencode-go": <OpencodeGoDialog onClose={close} />,
  };

  return {
    open: () => setShown("choose"),
    dialog: (shown === undefined ? null : dialogs[shown]) satisfies ReactNode,
  };
}
