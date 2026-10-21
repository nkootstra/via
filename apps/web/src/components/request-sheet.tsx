/**
 * The request of a failed turn, as via kept it, in a sheet beside the
 * conversation: what it asked for at the top, its messages by role down the
 * middle, as a conversation reads, and what each upstream answered at the end.
 * via redacted it by pattern before keeping it; what it replaced, and the
 * images it left out, stand out as chips, and a note says what it took out.
 * The body is fetched when the sheet opens, and copies whole as JSON.
 */
import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { CapturedRequest as CapturedRequestSchema } from "@via/server/admin-api";
import { Button, Callout, CopyIcon, EmptyState, Sheet, SheetContent, Skeleton } from "@via/ui";
import {
  colors,
  durations,
  fonts,
  fontWeights,
  radii,
  space,
  text,
  weights,
} from "@via/ui/tokens.stylex";
import { Option, Predicate, Schema } from "effect";
import { useId, useState, type ReactNode } from "react";
import { capturedRequestQuery } from "../api/admin.ts";
import type { CapturedRequest, TurnAttempt } from "../api/types.ts";
import { attemptOutcomeNames, categoryNames, didNotServe } from "../lib/attempt.ts";
import {
  markersIn,
  type Prompt,
  type PromptMessage,
  type PromptPart,
  promptOf,
} from "../lib/captured-prompt.ts";
import { withoutPrefix } from "../lib/model-entries.ts";
import { useMask } from "../lib/privacy.ts";
import { providerName } from "../lib/provider-name.ts";
import { formatMoment } from "../lib/time.ts";
import { useTimeFormat } from "../lib/time-format.ts";
import { formatCount } from "../lib/usage-format.ts";
import { useCopyText } from "./copy-text.ts";
import { ChevronRightIcon, DocumentIcon } from "./icons.tsx";
import { QueryError } from "./query-error.tsx";

const styles = stylex.create({
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2_5,
    margin: 0,
  },
  sectionTitle: {
    display: "flex",
    alignItems: "baseline",
    gap: space.s2,
    margin: 0,
    fontSize: text.caption,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  count: {
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  // The request's parameters: a term over its value, as many to a row as fit.
  parameters: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(8.5rem, 1fr))",
    gap: space.s1,
    margin: 0,
  },
  parameter: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    minWidth: 0,
    paddingBlock: space.s2,
    paddingInline: space.s2_5,
    borderRadius: radii.item,
    backgroundColor: `color-mix(in oklab, ${colors.foreground} 3.5%, transparent)`,
  },
  term: {
    fontSize: "11px",
    color: colors.mutedForeground,
  },
  value: {
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: text.caption,
    color: colors.foreground,
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  tool: {
    display: "inline-flex",
    alignItems: "center",
    height: "22px",
    paddingInline: space.s2,
    borderRadius: "6px",
    boxShadow: `inset 0 0 0 1px ${colors.border}`,
    fontFamily: fonts.mono,
    fontSize: "11px",
    color: colors.foreground,
  },
  more: {
    height: "22px",
    paddingInline: space.s2,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    fontFamily: "inherit",
    fontSize: "11px",
    color: colors.mutedForeground,
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.focusRing}` },
  },
  messages: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // A message: its role over its parts, a hairline down its side in the role's colour.
  message: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    minWidth: 0,
    paddingInlineStart: space.s3,
    borderInlineStartWidth: 2,
    borderInlineStartStyle: "solid",
  },
  role: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: "11px",
    letterSpacing: "0.02em",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.mutedForeground,
  },
  prose: {
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontSize: text.body,
    lineHeight: 1.6,
    color: colors.foreground,
  },
  // A block of code: a tool's arguments or result, an error's body, a body as JSON.
  code: {
    margin: 0,
    padding: space.s3,
    overflowX: "auto",
    borderRadius: radii.item,
    backgroundColor: `color-mix(in oklab, ${colors.foreground} 4%, transparent)`,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontFamily: fonts.mono,
    fontSize: "11.5px",
    lineHeight: 1.6,
    color: colors.foreground,
  },
  call: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    minWidth: 0,
  },
  callHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space.s1_5,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  callName: {
    fontFamily: fonts.mono,
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  callId: {
    fontFamily: fonts.mono,
    fontSize: "11px",
  },
  // What via put in place of a secret or an image: a chip in the text.
  marker: {
    display: "inline-block",
    paddingInline: "5px",
    marginInline: "1px",
    borderRadius: "5px",
    fontFamily: fonts.mono,
    fontSize: "0.85em",
    lineHeight: 1.5,
    whiteSpace: "nowrap",
    verticalAlign: "baseline",
  },
  redacted: {
    backgroundColor: colors.warningSubtle,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.warning} 35%, transparent)`,
    color: colors.foreground,
  },
  image: {
    backgroundColor: colors.infoSubtle,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.info} 35%, transparent)`,
    color: colors.foreground,
  },
  // A long block, cut short: it fades out into its "Show all".
  clipped: {
    maxHeight: "13.5em",
    overflow: "hidden",
    maskImage: "linear-gradient(to bottom, black 60%, transparent)",
  },
  toggle: {
    alignSelf: "flex-start",
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    height: "24px",
    paddingInline: space.s1_5,
    marginInlineStart: `calc(-1 * ${space.s1_5})`,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    fontFamily: "inherit",
    fontSize: text.caption,
    color: colors.mutedForeground,
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.focusRing}` },
  },
  chevron: {
    display: "inline-flex",
    transitionProperty: "transform",
    transitionDuration: durations.moderate,
    transitionTimingFunction: durations.pressEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
  chevronOpen: { transform: "rotate(90deg)" },
  preview: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  answer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    minWidth: 0,
  },
  answerHead: {
    margin: 0,
    fontSize: text.caption,
    lineHeight: 1.5,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  answerTitle: {
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  failed: { color: colors.destructive },
  note: { margin: 0 },
  notes: { display: "flex", flexDirection: "column", gap: space.s1 },
});

/** Each role's colour, down its messages' side. */
const roles = stylex.create({
  user: { borderInlineStartColor: colors.chart1 },
  assistant: { borderInlineStartColor: colors.success },
  tool: { borderInlineStartColor: colors.borderStrong },
  setup: { borderInlineStartColor: colors.warning },
  other: { borderInlineStartColor: colors.border },
});

/** The roles that set a prompt up: folded away, as they run long and rarely change. */
const SETUP_ROLES = new Set(["system", "developer", "instructions"]);

const roleNames = new Map([
  ["system", "System prompt"],
  ["developer", "Developer prompt"],
  ["instructions", "Instructions"],
  ["user", "User"],
  ["assistant", "Assistant"],
  ["tool", "Tool"],
]);

const roleStyles = new Map([
  ["user", roles.user],
  ["assistant", roles.assistant],
  ["tool", roles.tool],
]);

const roleStyle = (role: string) =>
  SETUP_ROLES.has(role) ? roles.setup : (roleStyles.get(role) ?? roles.other);

const roleName = (role: string) => roleNames.get(role) ?? role;

/** A block longer than this many lines, or characters, is cut short until asked for. */
const LONG_LINES = 12;

const LONG_CHARS = 1_200;

const lineCount = (value: string) => value.split("\n").length;

const isLong = (value: string) => lineCount(value) > LONG_LINES || value.length > LONG_CHARS;

/** `value`, its secrets and images as chips. */
function Marked({ value }: { readonly value: string }) {
  return markersIn(value).map((run, index) =>
    run.kind === "text" ? (
      run.text
    ) : (
      <span
        // The runs never reorder: the index is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        key={index}
        title={
          run.kind === "redacted"
            ? "via removed a secret here before keeping the request"
            : "via left this image out, keeping only its type and size"
        }
        {...stylex.props(styles.marker, run.kind === "redacted" ? styles.redacted : styles.image)}
      >
        {run.text}
      </span>
    ),
  );
}

/** A block that a long value is cut short in, with a button to show it all. */
function Clamped({ value, code = false }: { readonly value: string; readonly code?: boolean }) {
  const [all, setAll] = useState(false);
  const id = useId();
  const long = isLong(value);
  const clipped = long && !all;
  const Block = code ? "pre" : "p";

  return (
    <>
      <Block
        id={id}
        {...stylex.props(code ? styles.code : styles.prose, clipped && styles.clipped)}
      >
        <Marked value={value} />
      </Block>
      {long && (
        <button
          type="button"
          aria-expanded={all}
          aria-controls={id}
          onClick={() => setAll((was) => !was)}
          {...stylex.props(styles.toggle)}
        >
          {all ? "Show less" : `Show all ${formatCount(lineCount(value))} lines`}
        </button>
      )}
    </>
  );
}

function Part({ part }: { readonly part: PromptPart }) {
  switch (part.kind) {
    case "text":
      return <Clamped value={part.text} />;
    case "image":
      return (
        <p {...stylex.props(styles.prose)}>
          <Marked value={part.label} />
        </p>
      );
    case "reasoning":
      return (
        <div {...stylex.props(styles.call)}>
          <span {...stylex.props(styles.callHead)}>Reasoning summary</span>
          {part.text === "" ? (
            <p {...stylex.props(styles.answerHead)}>None sent; it was encrypted, or left out.</p>
          ) : (
            <Clamped value={part.text} />
          )}
        </div>
      );
    case "toolCall":
      return (
        <div {...stylex.props(styles.call)}>
          <span {...stylex.props(styles.callHead)}>
            <span aria-hidden="true">→</span>
            Calls <code {...stylex.props(styles.callName)}>{part.name}</code>
            {Option.isSome(part.id) && (
              <span {...stylex.props(styles.callId)}>{part.id.value}</span>
            )}
          </span>
          {part.arguments !== "" && <Clamped value={part.arguments} code />}
        </div>
      );
    case "toolResult":
      return (
        <div {...stylex.props(styles.call)}>
          <span {...stylex.props(styles.callHead)}>
            <span aria-hidden="true">←</span>
            Result
            {Option.isSome(part.id) && (
              <>
                {" of "}
                <span {...stylex.props(styles.callId)}>{part.id.value}</span>
              </>
            )}
          </span>
          <Clamped value={part.text} code />
        </div>
      );
    case "other":
      return <Clamped value={part.json} code />;
  }
}

/** The first line of a folded message, to say what's in it. */
const previewOf = (message: PromptMessage) =>
  message.parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join(" ")
    .trim()
    .split("\n")[0] ?? "";

const charsOf = (message: PromptMessage) =>
  message.parts.reduce((sum, part) => sum + (part.kind === "text" ? part.text.length : 0), 0);

function Message({ message }: { readonly message: PromptMessage }) {
  const setup = SETUP_ROLES.has(message.role);
  const [open, setOpen] = useState(!setup);
  const id = useId();
  const name = roleName(message.role);

  return (
    <li aria-label={name} {...stylex.props(styles.message, roleStyle(message.role))}>
      {setup ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((was) => !was)}
          {...stylex.props(styles.toggle)}
        >
          <span aria-hidden="true" {...stylex.props(styles.chevron, open && styles.chevronOpen)}>
            <ChevronRightIcon size={12} />
          </span>
          <span {...stylex.props(styles.role)}>{name}</span>
          <span {...stylex.props(styles.count)}>{formatCount(charsOf(message))} characters</span>
        </button>
      ) : (
        <span {...stylex.props(styles.role)}>{name}</span>
      )}
      {setup && !open && (
        <span aria-hidden="true" {...stylex.props(styles.answerHead, styles.preview)}>
          {previewOf(message)}
        </span>
      )}
      {open && (
        <div id={id} {...stylex.props(styles.call)}>
          {message.parts.length === 0 ? (
            <p {...stylex.props(styles.answerHead)}>Empty</p>
          ) : (
            message.parts.map((part, index) => (
              // A message's parts never reorder: the index is their identity.
              // oxlint-disable-next-line react/no-array-index-key
              <Part key={index} part={part} />
            ))
          )}
        </div>
      )}
    </li>
  );
}

/** How many tools show before the rest fold into "+N more". */
const TOOLS_SHOWN = 12;

function Tools({ tools }: { readonly tools: ReadonlyArray<string> }) {
  const [all, setAll] = useState(false);
  const shown = all ? tools : tools.slice(0, TOOLS_SHOWN);

  return (
    <ul aria-label="Tools" {...stylex.props(styles.chips)}>
      {shown.map((tool, index) => (
        // Two tools may share a name; their order never changes.
        // oxlint-disable-next-line react/no-array-index-key
        <li key={`${tool}-${index}`} aria-label={`Tool ${tool}`} {...stylex.props(styles.tool)}>
          {tool}
        </li>
      ))}
      {tools.length > TOOLS_SHOWN && (
        <li>
          <button
            type="button"
            onClick={() => setAll((was) => !was)}
            {...stylex.props(styles.more)}
          >
            {all ? "Show fewer" : `+${formatCount(tools.length - TOOLS_SHOWN)} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

function Section({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  const id = useId();

  return (
    <section aria-labelledby={id} {...stylex.props(styles.section)}>
      <h3 id={id} {...stylex.props(styles.sectionTitle)}>
        {title}
        {count !== undefined && <span {...stylex.props(styles.count)}>{formatCount(count)}</span>}
      </h3>
      {children}
    </section>
  );
}

function PromptView({ prompt }: { readonly prompt: Prompt }) {
  return (
    <>
      {prompt.parameters.length > 0 && (
        <Section title="Parameters">
          <dl {...stylex.props(styles.parameters)}>
            {prompt.parameters.map(([term, value]) => (
              <div key={term} {...stylex.props(styles.parameter)}>
                <dt {...stylex.props(styles.term)}>{term}</dt>
                <dd title={value} {...stylex.props(styles.value)}>
                  {term === "Model" ? withoutPrefix(value) || value : value}
                </dd>
              </div>
            ))}
          </dl>
          {prompt.tools.length > 0 && <Tools tools={prompt.tools} />}
        </Section>
      )}
      <Section title="Messages" count={prompt.messages.length}>
        <ol aria-label="Messages" {...stylex.props(styles.messages)}>
          {prompt.messages.map((message, index) => (
            // Messages never reorder: the index is their identity.
            // oxlint-disable-next-line react/no-array-index-key
            <Message key={index} message={message} />
          ))}
        </ol>
      </Section>
    </>
  );
}

const pretty = (json: CapturedRequest["request"]) =>
  Predicate.isString(json) ? json : JSON.stringify(json, null, 2);

/** One upstream's answer: the attempt it was, from the turn's attempts, and its body. */
function UpstreamAnswer({
  answer,
  attempt,
}: {
  readonly answer: CapturedRequest["upstreamErrors"][number];
  readonly attempt: Option.Option<TurnAttempt>;
}) {
  const id = useId();
  const mask = useMask();

  const said = Option.match(attempt, {
    onNone: () => [],
    onSome: (tried) => [
      Option.match(tried.downstreamProvider, {
        onNone: () => providerName(tried.provider),
        onSome: (downstream) => `${providerName(tried.provider)} → ${downstream}`,
      }),
      ...Option.toArray(Option.map(tried.accountLabel, mask.key)),
      withoutPrefix(tried.model) || "Unknown model",
    ],
  });

  const ended = Option.map(attempt, (tried) =>
    Option.match(tried.category, {
      onNone: () => attemptOutcomeNames[tried.outcome],
      onSome: (category) => categoryNames[category],
    }),
  );

  return (
    <section aria-labelledby={id} {...stylex.props(styles.answer)}>
      <p id={id} {...stylex.props(styles.answerHead)}>
        <span {...stylex.props(styles.answerTitle)}>Attempt {answer.seq + 1}</span>
        {[...said, ...(answer.status === null ? [] : [`HTTP ${answer.status}`])].map(
          (part) => ` · ${part}`,
        )}
        {Option.isSome(ended) && (
          <>
            {" · "}
            <span
              {...stylex.props(
                Option.exists(attempt, (tried) => didNotServe(tried)) && styles.failed,
              )}
            >
              {ended.value}
            </span>
          </>
        )}
      </p>
      <Clamped value={mask.text(pretty(answer.body))} code />
    </section>
  );
}

const encodeCaptured = Schema.encodeSync(CapturedRequestSchema);

/** The whole of a captured request, as via sent it, for the clipboard. */
const capturedJson = (captured: CapturedRequest) =>
  JSON.stringify(encodeCaptured(captured), null, 2);

const formatBytes = (bytes: number) =>
  bytes < 1_024
    ? `${formatCount(bytes)} B`
    : bytes < 1_048_576
      ? `${(bytes / 1_024).toFixed(1)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

function Captured({
  captured,
  attempts,
}: {
  readonly captured: CapturedRequest;
  readonly attempts: ReadonlyArray<TurnAttempt>;
}) {
  const prompt = promptOf(captured.request);
  const removed = captured.redactions.reduce((sum, { count }) => sum + count, 0);

  return (
    <div {...stylex.props(styles.body)}>
      {(removed > 0 || captured.truncated) && (
        <Callout tone="info">
          <div {...stylex.props(styles.notes)}>
            {removed > 0 && (
              <p {...stylex.props(styles.note)}>
                via replaced{" "}
                {captured.redactions
                  .map(({ kind, count }) => `${formatCount(count)} × ${kind}`)
                  .join(", ")}{" "}
                before keeping this. It finds secrets by their pattern, which can miss one, so read
                it before you share it.
              </p>
            )}
            {captured.truncated && (
              <p {...stylex.props(styles.note)}>
                via cut some long strings short to keep this under 4 MB.
              </p>
            )}
          </div>
        </Callout>
      )}
      {Option.isSome(prompt) ? (
        <PromptView prompt={prompt.value} />
      ) : (
        <Section title="Request">
          <p {...stylex.props(styles.answerHead)}>
            via doesn't read requests of this shape, so here it is as it came.
          </p>
          <Clamped value={pretty(captured.request)} code />
        </Section>
      )}
      {captured.upstreamErrors.length > 0 && (
        <Section title="What the upstreams answered" count={captured.upstreamErrors.length}>
          {captured.upstreamErrors.map((answer) => (
            <UpstreamAnswer
              key={answer.seq}
              answer={answer}
              attempt={Option.fromNullishOr(attempts.find((tried) => tried.seq === answer.seq))}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

/** What via answered for the request: its body, or that it kept none. */
function Kept({
  captured,
  attempts,
}: {
  readonly captured: Option.Option<CapturedRequest>;
  readonly attempts: ReadonlyArray<TurnAttempt>;
}) {
  return Option.isSome(captured) ? (
    <Captured captured={captured.value} attempts={attempts} />
  ) : (
    <EmptyState
      icon={<DocumentIcon size={18} />}
      title="No prompt kept"
      description="via has no prompt of this request: it was deleted, or forgotten after 7 days."
    />
  );
}

/** The turn a sheet shows the request of. */
export interface ViewedTurn {
  readonly requestId: string;
  readonly number: number;
  readonly attempts: ReadonlyArray<TurnAttempt>;
}

export function RequestSheet({
  turn,
  open,
  onOpenChange,
  onClosed,
}: {
  readonly turn: ViewedTurn;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Once it has closed, its exit done. */
  readonly onClosed: () => void;
}) {
  const query = useQuery({ ...capturedRequestQuery(turn.requestId), enabled: open });
  const copy = useCopyText();
  const format = useTimeFormat();
  const captured = Option.flatten(Option.fromNullishOr(query.data));

  const description = Option.match(captured, {
    onNone: () => "As via kept it, redacted",
    onSome: (kept) =>
      [
        `/v1/${kept.endpoint}`,
        formatBytes(kept.sizeBytes),
        `kept ${formatMoment(kept.capturedAt, format)}`,
      ].join(" · "),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => !next && onClosed()}
    >
      <SheetContent
        title={`Request of turn ${turn.number}`}
        description={description}
        actions={
          Option.isSome(captured) && (
            <Button
              variant="secondary"
              size="compact"
              onClick={() =>
                copy.mutate({ text: capturedJson(captured.value), copied: "Request copied" })
              }
            >
              <CopyIcon size={13} />
              Copy JSON
            </Button>
          )
        }
      >
        {query.isError ? (
          <QueryError what="the request" error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data === undefined ? (
          <div {...stylex.props(styles.body)}>
            <Skeleton height="64px" />
            <Skeleton height="120px" />
            <Skeleton height="200px" />
          </div>
        ) : (
          <Kept captured={query.data} attempts={turn.attempts} />
        )}
      </SheetContent>
    </Sheet>
  );
}
