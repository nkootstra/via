import * as stylex from "@stylexjs/stylex";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { isAppPath } from "../lib/sign-in-redirect.ts";
import { startPath } from "../lib/start-page.ts";
import { Button, Callout, Field, Input, VisuallyHidden } from "@via/ui";
import { colors, fonts, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { Schema } from "effect";
import { AnimatePresence, motion, useAnimate, useReducedMotion } from "motion/react";
import { type Ref, useEffect, useEffectEvent, useState } from "react";
import { sessionQuery, signIn } from "../api/admin.ts";
import { Centered } from "../components/centered.tsx";
import { EyeIcon, EyeOffIcon } from "../components/icons.tsx";
import { countdown, useNow } from "../lib/time.ts";

/** How long via refuses sign-ins after too many wrong keys: its failure window. */
const LOCKOUT_MS = 60_000;

const Search = Schema.Struct({
  // The page, with its search, to go back to once signed in.
  redirect: Schema.optional(Schema.String),
  // Set when via ended the session, so the page says why the viewer is back here.
  expired: Schema.optional(Schema.Boolean),
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
    fontSize: text.title,
    letterSpacing: "-0.01em",
    fontVariationSettings: weights.bold,
    fontWeight: fontWeights.bold,
  },
  lead: {
    marginTop: space.s1_5,
    marginBottom: space.s6,
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  code: {
    fontFamily: fonts.mono,
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
  expired: { marginBottom: space.s4 },
  submit: { width: "100%" },
  // The countdown's digits keep one width, so the line doesn't jiggle as it ticks.
  left: { fontVariantNumeric: "tabular-nums" },
});

type Problem =
  // Which wrong key in a row this is, so a repeat is heard, not just seen.
  | { readonly kind: "wrong-key"; readonly attempt: number }
  | { readonly kind: "not-kept" }
  | { readonly kind: "too-many"; readonly until: number }
  | { readonly kind: "unreachable"; readonly message: string };

/**
 * What went wrong, in one alert that stays up from one outcome to the next and
 * changes its words. It opens and closes by its height, or only fades for a
 * viewer who asks for less motion; `box` is what a repeated wrong key shakes.
 */
function Alert({
  problem,
  box,
  onUnlock,
}: {
  readonly problem: Problem;
  readonly box: Ref<HTMLDivElement>;
  readonly onUnlock: () => void;
}) {
  const closed = useReducedMotion() === true ? "auto" : 0;

  return (
    <motion.div
      initial={{ opacity: 0, height: closed }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: closed }}
      transition={{ type: "spring", duration: 0.24, bounce: 0 }}
    >
      <div ref={box}>
        {/* A note holding the alert, so the countdown beside it isn't announced. */}
        <Callout tone="danger">
          <span role="alert">
            {problem.kind === "wrong-key" && (
              <>
                That key isn't right. Check it and try again.
                {problem.attempt > 1 && (
                  <VisuallyHidden> (attempt {problem.attempt})</VisuallyHidden>
                )}
              </>
            )}
            {problem.kind === "not-kept" &&
              "via took the key, but this browser didn't keep the session. Clear this site's cookies and sign in again."}
            {problem.kind === "too-many" &&
              "Too many wrong keys. via is pausing sign-ins for a minute."}
            {problem.kind === "unreachable" && problem.message}
          </span>
          {problem.kind === "too-many" && (
            <>
              {" "}
              <Lockout until={problem.until} onUnlock={onUnlock} />
            </>
          )}
        </Callout>
      </div>
    </motion.div>
  );
}

/**
 * How long until via takes sign-ins again, ticking only while it is shown and
 * kept out of the alert, which says so once rather than every second. The
 * tick that reaches zero lifts the lockout, so the words and the button agree.
 */
function Lockout({ until, onUnlock }: { readonly until: number; readonly onUnlock: () => void }) {
  const left = until - useNow();
  const over = left <= 0;
  const unlock = useEffectEvent(onUnlock);

  useEffect(() => {
    if (over) unlock();
  }, [over]);

  return (
    <span aria-live="off" {...stylex.props(styles.left)}>
      {left > 0 ? `Try again in ${countdown(left)}.` : "You can try again now."}
    </span>
  );
}

function SignIn() {
  const navigate = useNavigate();
  const { redirect: back, expired = false } = Route.useSearch();
  const { queryClient } = Route.useRouteContext();
  const [key, setKey] = useState("");
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [locked, setLocked] = useState(false);
  const [box, animate] = useAnimate<HTMLDivElement>();
  const reduceMotion = useReducedMotion() === true;

  // Another wrong key: the alert shakes, or dips for less motion, as its words
  // don't change; a screen reader hears the attempt instead.
  const again = () =>
    animate(box.current, reduceMotion ? { opacity: [1, 0.4, 1] } : { x: [0, -4, 4, -2, 0] }, {
      duration: 0.3,
      ease: "easeOut",
    });

  const mutation = useMutation({
    mutationFn: signIn,
    onSuccess: (outcome) => {
      if (outcome === "wrong-key") {
        if (problem?.kind !== "wrong-key") return setProblem({ kind: "wrong-key", attempt: 1 });
        setProblem({ kind: "wrong-key", attempt: problem.attempt + 1 });

        return void again();
      }

      if (outcome === "not-kept") return setProblem({ kind: "not-kept" });

      if (outcome === "too-many") {
        setLocked(true);

        return setProblem({ kind: "too-many", until: Date.now() + LOCKOUT_MS });
      }

      setProblem(null);
      setKey("");
      queryClient.setQueryData(sessionQuery.queryKey, true);
      // Only ever to a page of the app: a link elsewhere would hand the session's tab to it.
      void (back !== undefined && isAppPath(back)
        ? navigate({ href: back })
        : navigate({ to: startPath() }));
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
      {expired && (
        <div {...stylex.props(styles.expired)}>
          <Callout tone="info">Your session ended. Sign in again.</Callout>
        </div>
      )}
      <form
        {...stylex.props(styles.form)}
        onSubmit={(event) => {
          event.preventDefault();
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
                // The name stays put; whether the key shows is the pressed state.
                aria-label="Show key"
                aria-pressed={shown}
                onClick={() => setShown((value) => !value)}
              >
                {shown ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
              </Button>
            }
          />
        </Field>
        <AnimatePresence initial={false}>
          {problem !== null && (
            <Alert problem={problem} box={box} onUnlock={() => setLocked(false)} />
          )}
        </AnimatePresence>
        <Button type="submit" loading={mutation.isPending} disabled={locked} xstyle={styles.submit}>
          Sign in
        </Button>
      </form>
    </Centered>
  );
}
