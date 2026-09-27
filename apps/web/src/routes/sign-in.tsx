import * as stylex from "@stylexjs/stylex";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Button, Field, Input } from "@via/ui";
import { colors, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { Schema } from "effect";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { sessionQuery, signIn } from "../api/admin.ts";
import { Centered } from "../components/centered.tsx";
import { EyeIcon, EyeOffIcon } from "../components/icons.tsx";
import { countdown, useNow } from "../lib/time.ts";

/** How long via refuses sign-ins after too many wrong keys: its failure window. */
const LOCKOUT_MS = 60_000;

const Search = Schema.Struct({
  redirect: Schema.optional(Schema.Literals(["/", "/accounts", "/keys", "/models"])),
});

export const Route = createFileRoute("/sign-in")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  // Signed in already: straight to the dashboard.
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.fetchQuery(sessionQuery)) throw redirect({ to: "/" });
  },
  head: () => ({ meta: [{ title: "Sign in · via" }] }),
  component: SignIn,
});

const styles = stylex.create({
  title: {
    margin: 0,
    fontSize: "18px",
    letterSpacing: "-0.01em",
    fontVariationSettings: weights.bold,
  },
  lead: {
    marginTop: space.s1_5,
    marginBottom: space.s6,
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.92em",
    paddingInline: "4px",
    paddingBlock: "1px",
    borderRadius: "4px",
    backgroundColor: colors.muted,
    color: colors.foreground,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    margin: 0,
  },
  submit: { width: "100%" },
  alert: {
    display: "flex",
    gap: space.s2,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderRadius: radii.item,
    fontSize: text.caption,
    lineHeight: 1.45,
    color: colors.foreground,
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 10%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.destructive} 30%, transparent)`,
  },
  alertDot: {
    flexShrink: 0,
    width: "6px",
    height: "6px",
    marginTop: "5px",
    borderRadius: radii.full,
    backgroundColor: colors.destructive,
  },
});

type Problem =
  | { readonly kind: "wrong-key" }
  | { readonly kind: "not-kept" }
  | { readonly kind: "too-many"; readonly until: number }
  | { readonly kind: "unreachable"; readonly message: string };

function Alert({ problem }: { readonly problem: Problem }) {
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: "spring", duration: 0.24, bounce: 0 }}
    >
      <div {...stylex.props(styles.alert)}>
        <span aria-hidden="true" {...stylex.props(styles.alertDot)} />
        <span>
          {problem.kind === "wrong-key" && "That key isn't right. Check it and try again."}
          {problem.kind === "not-kept" &&
            "via took the key, but this browser didn't keep the session. Clear this site's cookies and sign in again."}
          {problem.kind === "too-many" && <Lockout until={problem.until} />}
          {problem.kind === "unreachable" && problem.message}
        </span>
      </div>
    </motion.div>
  );
}

function Lockout({ until }: { readonly until: number }) {
  const now = useNow();
  const left = until - now;

  return left > 0
    ? `Too many wrong keys. via is pausing sign-ins; try again in ${countdown(left)}.`
    : "You can try again now.";
}

function SignIn() {
  const navigate = useNavigate();
  const { redirect: back } = Route.useSearch();
  const { queryClient } = Route.useRouteContext();
  const [key, setKey] = useState("");
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const now = useNow();
  const locked = problem?.kind === "too-many" && problem.until > now;

  const mutation = useMutation({
    mutationFn: signIn,
    onSuccess: (outcome) => {
      if (outcome === "wrong-key") return setProblem({ kind: "wrong-key" });

      if (outcome === "not-kept") return setProblem({ kind: "not-kept" });

      if (outcome === "too-many")
        return setProblem({ kind: "too-many", until: Date.now() + LOCKOUT_MS });

      setKey("");
      queryClient.setQueryData(sessionQuery.queryKey, true);
      void navigate({ to: back ?? "/" });
    },
    onError: (error) => setProblem({ kind: "unreachable", message: error.message }),
  });

  return (
    <Centered footnote="The key only signs you in: via keeps the session in a secure cookie, and this page never stores the key.">
      <h1 {...stylex.props(styles.title)}>Sign in</h1>
      <p {...stylex.props(styles.lead)}>
        Enter the admin key this server runs with: its{" "}
        <code {...stylex.props(styles.code)}>VIA_ADMIN_KEY</code> setting.
      </p>
      <form
        {...stylex.props(styles.form)}
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(null);
          mutation.mutate(key);
        }}
      >
        <Field label="Admin key">
          {/* The one field on the page, so it shows at rest. */}
          <Input
            type={shown ? "text" : "password"}
            name="admin-key"
            autoComplete="current-password"
            spellCheck={false}
            required
            value={key}
            onValueChange={setKey}
            sunken
            trailing={
              <Button
                type="button"
                variant="ghost"
                size="icon-compact"
                aria-label={shown ? "Hide key" : "Show key"}
                aria-pressed={shown}
                onClick={() => setShown((value) => !value)}
              >
                {shown ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
              </Button>
            }
          />
        </Field>
        <AnimatePresence initial={false}>
          {problem !== null && <Alert key={problem.kind} problem={problem} />}
        </AnimatePresence>
        <Button type="submit" loading={mutation.isPending} disabled={locked} xstyle={styles.submit}>
          Sign in
        </Button>
      </form>
    </Centered>
  );
}
