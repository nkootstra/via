import * as stylex from "@stylexjs/stylex";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  Button,
  Callout,
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
  VisuallyHidden,
} from "@via/ui";
import { colors, durations, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { addOpencodeGo, loginStatusQuery, refreshPool, startLogin } from "../api/admin.ts";
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
    // Nested in the dialog's rounder corners.
    borderRadius: radii.item,
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
    backgroundColor: colors.info,
    // Held still for a viewer who asks for less motion; the text says it's waiting.
    animationName: {
      default: stylex.keyframes({
        "0%, 100%": { opacity: 1, transform: "scale(1)" },
        "50%": { opacity: 0.35, transform: "scale(0.8)" },
      }),
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
  },
  choices: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
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
    transitionProperty: "background-color",
    transitionDuration: durations.fast,
    outline: "none",
    // The hairline ring Button shows on focus.
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.border}`,
      ":focus-visible": `inset 0 0 0 1px ${colors.border}, 0 0 0 1px ${colors.focusRing}`,
    },
  },
  // The logo's tile, as the overview's cards have; in the dialog's colour, so it
  // shows against the muted button.
  choiceLogo: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "32px",
    height: "32px",
    borderRadius: radii.item,
    backgroundColor: colors.surface5,
  },
  choiceText: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
  },
  choiceName: {
    fontSize: text.body,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
  choiceHow: {
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  step: { outline: "none" },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
});

/** Focus a step as it comes in: its first field, or the step itself to read from. */
const focusStep = (step: HTMLDivElement | null) => (step?.querySelector("input") ?? step)?.focus();

/** A device-code login: the code to enter, then polling every 2 s until the account is added. */
function CodexStep({
  start,
  onClose,
}: {
  readonly start: UseMutationResult<StartedLogin, Error, void>;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const login = start.data;

  // A login for an account already in the pool signs it in again: via gives it
  // fresh tokens, and lifts its lockout if it had one.
  const signedIn = (account: Account, added: boolean) => {
    refreshPool(queryClient);
    toast.add(
      added
        ? { title: "Account added", description: `${account.label} is in the pool.` }
        : { title: "Signed in again", description: `via has fresh tokens for ${account.label}.` },
    );
    onClose();
  };

  const status = useQuery(
    loginStatusQuery(login?.id, (answer) => {
      if (answer.status === "added" || answer.status === "updated") {
        signedIn(answer.account, answer.status === "added");
      }
    }),
  );

  const outcome = status.data;

  const failed =
    outcome?.status === "failed" ? outcome.error : (start.error?.message ?? status.error?.message);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a ChatGPT account</DialogTitle>
        <DialogDescription>
          Sign in to ChatGPT in another tab and enter this code. via adds the account as soon as you
          approve it.
        </DialogDescription>
      </DialogHeader>

      {failed !== undefined ? (
        <Callout tone="danger" role="alert">
          Sign-in didn't finish: {failed}
        </Callout>
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
            <li>Open the sign-in page and sign in to the ChatGPT account you want to add.</li>
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
            <Button
              render={(props) => (
                <a {...props} href={login.verificationUrl} target="_blank" rel="noreferrer">
                  {props.children}
                </a>
              )}
            >
              Open sign-in page
              <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
              <ExternalIcon size={14} />
            </Button>
          )
        )}
      </DialogFooter>
    </>
  );
}

/** Which kind of account to add: a ChatGPT one, by device login, or an OpenCode Go one, by API key. */
function ChooseStep({
  onCodex,
  onOpencodeGo,
}: {
  readonly onCodex: () => void;
  readonly onOpencodeGo: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add an account</DialogTitle>
        <DialogDescription>Choose the kind of account to add.</DialogDescription>
      </DialogHeader>
      <div {...stylex.props(styles.choices)}>
        <button type="button" onClick={onCodex} {...stylex.props(styles.choice)}>
          <span aria-hidden="true" {...stylex.props(styles.choiceLogo)}>
            <CodexIcon size={18} />
          </span>
          <span {...stylex.props(styles.choiceText)}>
            <span {...stylex.props(styles.choiceName)}>ChatGPT (Codex)</span>
            <span {...stylex.props(styles.choiceHow)}>Sign in with a device code.</span>
          </span>
        </button>
        <button type="button" onClick={onOpencodeGo} {...stylex.props(styles.choice)}>
          <span aria-hidden="true" {...stylex.props(styles.choiceLogo)}>
            <ProviderLogo name="opencode-go" size={18} />
          </span>
          <span {...stylex.props(styles.choiceText)}>
            <span {...stylex.props(styles.choiceName)}>OpenCode Go</span>
            <span {...stylex.props(styles.choiceHow)}>Paste an API key.</span>
          </span>
        </button>
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
      </DialogFooter>
    </>
  );
}

/** Pasting an OpenCode Go API key, which via checks with OpenCode Go before it keeps it. */
function OpencodeGoStep({ onClose }: { readonly onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [apiKey, setApiKey] = useState("");
  const [missing, setMissing] = useState(false);

  const add = useMutation({
    mutationFn: () => addOpencodeGo(apiKey.trim()),
    onSuccess: (outcome) => {
      if (!outcome.added) return;
      refreshPool(queryClient);
      toast.add({ title: "Account added", description: `${outcome.label} is in the pool.` });
      onClose();
    },
  });

  const problem = add.data?.added === false ? add.data.problem : add.error?.message;

  return (
    <form
      {...stylex.props(styles.form)}
      onSubmit={(event) => {
        event.preventDefault();

        if (apiKey.trim() === "") return setMissing(true);
        add.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add an OpenCode Go account</DialogTitle>
        <DialogDescription>
          Paste an API key from your OpenCode Go account. via checks it with OpenCode Go before
          adding it, and only ever shows its last four characters.
        </DialogDescription>
      </DialogHeader>
      <Field label="API key" error={missing ? "Paste the OpenCode Go API key." : problem}>
        <Input
          type="password"
          autoComplete="off"
          value={apiKey}
          onValueChange={(value) => {
            setApiKey(value);
            setMissing(false);
            add.reset();
          }}
        />
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
        <Button type="submit" loading={add.isPending}>
          Add account
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Adding an account, in place on whichever page asks: `open` asks which kind,
 * then starts a device-code login for a ChatGPT one, or takes an OpenCode Go
 * key, in the dialog `dialog` renders. Once a ChatGPT account is added, the
 * pool, its usage, the accounts and their models are fetched again.
 */
export function useAddAccount() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"choose" | "codex" | "opencode-go">("choose");
  const start = useMutation({ mutationFn: startLogin });
  const close = () => setOpen(false);

  const codex = () => {
    start.mutate();
    setStep("codex");
  };

  const steps = {
    choose: <ChooseStep onCodex={codex} onOpencodeGo={() => setStep("opencode-go")} />,
    codex: <CodexStep start={start} onClose={close} />,
    "opencode-go": <OpencodeGoStep onClose={close} />,
  };

  // One dialog throughout: a step swaps only what is in it, and it stays
  // mounted while it closes, starting over once it has.
  const dialog = (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(opened) => !opened && setStep("choose")}
    >
      <DialogContent size="lg">
        {/* One step leaves before the next comes, so the dialog is named by one title at a time. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            ref={step === "choose" ? undefined : focusStep}
            tabIndex={-1}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            {...stylex.props(styles.step)}
          >
            {steps[step]}
          </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );

  return {
    open: () => setOpen(true),
    /** Opens at the ChatGPT sign-in, skipping the choice: to sign an account in again. */
    openCodex: () => {
      codex();
      setOpen(true);
    },
    dialog: dialog satisfies ReactNode,
  };
}
