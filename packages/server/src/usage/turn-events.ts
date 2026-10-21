// The turns in flight, as `GET /admin/events` sends them. It imports only `effect` and
// `@via/usage/entry`, so the admin API's contract, which a browser bundles, includes it.
import { RequestAttempt, UsageEntry } from "@via/usage/entry";
import { Schema } from "effect";

const Nullable = <S extends Schema.Top>(schema: S) => Schema.OptionFromNullOr(schema);

/**
 * An upstream attempt still under way: sent, perhaps answered, not yet ended, so it
 * has no duration or outcome yet.
 */
const OpenAttempt = Schema.Struct({
  state: Schema.Literal("open"),
  requestId: Schema.String,
  /** Its place among the request's attempts, from 0. */
  seq: Schema.Finite,
  /** When via sent it, in epoch milliseconds. */
  startedAt: Schema.Finite,
  provider: Schema.String,
  model: Schema.String,
  accountId: Nullable(Schema.String),
  accountLabel: Nullable(Schema.String),
  /** The status the upstream answered with, once it has. */
  status: Nullable(Schema.Finite),
  /** From `startedAt` to the first chunk of a streamed answer, once it came. */
  firstChunkMs: Nullable(Schema.Finite),
});

/** An attempt that ended before its turn did: one via moved on from. */
const EndedAttempt = Schema.Struct({ state: Schema.Literal("ended"), ...RequestAttempt.fields });

/** An upstream attempt of a turn in flight, as it stands now. */
export const LiveAttempt = Schema.Union([OpenAttempt, EndedAttempt]);

export type LiveAttempt = typeof LiveAttempt.Type;

/** A request via is handling now, a turn of its conversation. Prompts and answers aren't in it. */
export const LiveTurn = Schema.Struct({
  requestId: Schema.String,
  /** When the request came in, in epoch milliseconds. */
  at: Schema.Finite,
  /** The model the client asked for. */
  model: Schema.String,
  conversationId: Nullable(Schema.String),
  parentConversationId: Nullable(Schema.String),
  agentType: Nullable(Schema.String),
  /** The harness that sent it, as its User-Agent names it. */
  client: Nullable(Schema.String),
  keyName: Nullable(Schema.String),
  /** Its upstream attempts so far, in order. */
  attempts: Schema.Array(LiveAttempt),
});

export type LiveTurn = typeof LiveTurn.Type;

/** A turn that ended, as the usage history keeps it. */
const EndedTurn = Schema.Struct({ entry: UsageEntry, attempts: Schema.Array(RequestAttempt) });

export type EndedTurn = typeof EndedTurn.Type;

/** Every event about the turns in flight, as `GET /admin/events` sends it. */
export const TurnEvent = Schema.Union([
  /** A turn started, or, to a listener that connects, is in flight. */
  Schema.Struct({ event: Schema.Literal("turn.started"), data: Schema.fromJsonString(LiveTurn) }),
  /** An attempt of a turn in flight started, was answered, sent its first chunk, or ended. */
  Schema.Struct({
    event: Schema.Literal("turn.attempt"),
    data: Schema.fromJsonString(LiveAttempt),
  }),
  /** A turn ended, however it did; it is in the usage history now. */
  Schema.Struct({ event: Schema.Literal("turn.ended"), data: Schema.fromJsonString(EndedTurn) }),
]);

export type TurnEvent = typeof TurnEvent.Type;
