import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

const Nullable = <S extends Schema.Top>(schema: S) => Schema.OptionFromNullOr(schema);

/** One finished request, as the usage history keeps it. Prompts and answers are never kept. */
export const UsageEntry = Schema.Struct({
  requestId: Schema.String,
  /** When the request came in, in epoch milliseconds. */
  at: Schema.Finite,
  status: Schema.Finite,
  /** The error code of an answer via gave itself, such as `rate_limit_exceeded`. */
  error: Nullable(Schema.String),
  /** How a streamed answer ended: `completed`, `client_aborted` or `failed`. */
  streamEnd: Nullable(Schema.String),
  keyId: Nullable(Schema.String),
  /** The key's name when the request came in; a key can be renamed or revoked since. */
  keyName: Nullable(Schema.String),
  model: Schema.String,
  /** `codex`, `opencode-go`, or the name of the provider that served it. */
  provider: Schema.String,
  accountId: Nullable(Schema.String),
  /** The account's label when the request came in. */
  accountLabel: Nullable(Schema.String),
  inputTokens: Nullable(Schema.Finite),
  cachedTokens: Nullable(Schema.Finite),
  outputTokens: Nullable(Schema.Finite),
  reasoningTokens: Nullable(Schema.Finite),
  /** What the upstream says it billed, in USD. */
  costUsd: Nullable(Schema.Finite),
  durationMs: Schema.Finite,
  firstChunkMs: Nullable(Schema.Finite),
});

export type UsageEntry = typeof UsageEntry.Type;

/** Where a page of the request list starts: just after this request. */
export interface RequestCursor {
  readonly at: number;
  readonly requestId: string;
}

/**
 * Whether a request failed: an error status, other than a client giving up
 * (499), or a stream that broke off.
 */
export type Outcome = "ok" | "error";

export interface RequestQuery {
  readonly from: number;
  readonly to: number;
  readonly limit: number;
  readonly cursor?: RequestCursor | undefined;
  readonly model?: string | undefined;
  readonly accountId?: string | undefined;
  readonly keyId?: string | undefined;
  readonly outcome?: Outcome | undefined;
}

export interface RequestPage {
  readonly requests: ReadonlyArray<UsageEntry>;
  /** Where the next page starts, when there is one. */
  readonly next: Option.Option<RequestCursor>;
}

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(UsageEntry));

const encodeEntry = Schema.encodeEffect(UsageEntry);

const migrations = Migrator.fromRecord({
  "1_requests": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE requests (
        request_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        status INTEGER NOT NULL,
        error TEXT,
        stream_end TEXT,
        key_id TEXT,
        key_name TEXT,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_id TEXT,
        account_label TEXT,
        input_tokens INTEGER,
        cached_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_tokens INTEGER,
        cost_usd REAL,
        duration_ms INTEGER NOT NULL,
        first_chunk_ms INTEGER
      )
    `;
    yield* sql`CREATE INDEX requests_at ON requests (at, request_id)`;
    yield* sql`CREATE INDEX requests_key ON requests (key_id, at)`;
    yield* sql`CREATE INDEX requests_account ON requests (account_id, at)`;
    yield* sql`CREATE INDEX requests_model ON requests (model, at)`;
  }),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * The SQL condition for a failed request, as `Outcome` defines it. `IS`, not `=`: a
   * request without a stream has no `stream_end`, and `NOT` of a NULL would drop it.
   */
  const failed = sql`((status >= 400 AND status <> 499) OR stream_end IS 'failed')`;

  const columns = sql`
    request_id AS "requestId", at, status, error, stream_end AS "streamEnd",
    key_id AS "keyId", key_name AS "keyName", model, provider,
    account_id AS "accountId", account_label AS "accountLabel",
    input_tokens AS "inputTokens", cached_tokens AS "cachedTokens",
    output_tokens AS "outputTokens", reasoning_tokens AS "reasoningTokens",
    cost_usd AS "costUsd", duration_ms AS "durationMs", first_chunk_ms AS "firstChunkMs"
  `;

  const record = Effect.fn("UsageHistory.record")(function* (entry: UsageEntry) {
    // `entry` is already typed as the schema's Type, so encoding can only fail on a programming error.
    const row = yield* encodeEntry(entry).pipe(Effect.orDie);

    yield* sql`INSERT INTO requests ${sql.insert({
      request_id: row.requestId,
      at: row.at,
      status: row.status,
      error: row.error,
      stream_end: row.streamEnd,
      key_id: row.keyId,
      key_name: row.keyName,
      model: row.model,
      provider: row.provider,
      account_id: row.accountId,
      account_label: row.accountLabel,
      input_tokens: row.inputTokens,
      cached_tokens: row.cachedTokens,
      output_tokens: row.outputTokens,
      reasoning_tokens: row.reasoningTokens,
      cost_usd: row.costUsd,
      duration_ms: row.durationMs,
      first_chunk_ms: row.firstChunkMs,
    })}`;
  });

  const requests = Effect.fn("UsageHistory.requests")(function* (query: RequestQuery) {
    const where = sql.and([
      sql`at >= ${query.from}`,
      sql`at < ${query.to}`,
      ...(query.cursor === undefined
        ? []
        : [
            sql`(at < ${query.cursor.at} OR (at = ${query.cursor.at} AND request_id < ${query.cursor.requestId}))`,
          ]),
      ...(query.model === undefined ? [] : [sql`model = ${query.model}`]),
      ...(query.accountId === undefined ? [] : [sql`account_id = ${query.accountId}`]),
      ...(query.keyId === undefined ? [] : [sql`key_id = ${query.keyId}`]),
      ...(query.outcome === undefined
        ? []
        : [query.outcome === "error" ? failed : sql`NOT ${failed}`]),
    ]);

    // One more than a page, to tell whether another page follows.
    const rows = yield* sql`
      SELECT ${columns} FROM requests WHERE ${where}
      ORDER BY at DESC, request_id DESC LIMIT ${query.limit + 1}
    `;

    // Rows only ever come from `record`, so they always decode.
    const entries = yield* decodeEntries(rows).pipe(Effect.orDie);
    const page = entries.slice(0, query.limit);
    const last = page.at(-1);

    return {
      requests: page,
      next:
        entries.length > query.limit && last !== undefined
          ? Option.some({ at: last.at, requestId: last.requestId })
          : Option.none(),
    } satisfies RequestPage;
  });

  return { record, requests };
});

/** Every request via has served, kept in SQLite so it outlives a restart. */
export class UsageHistory extends Context.Service<
  UsageHistory,
  {
    /** Keeps one finished request. */
    readonly record: (entry: UsageEntry) => Effect.Effect<void, SqlError>;
    /** A page of the requests in `[from, to)`, newest first. */
    readonly requests: (query: RequestQuery) => Effect.Effect<RequestPage, SqlError>;
  }
>()("via/UsageHistory") {
  /** The history in the SQLite database at `filename`, created and migrated as needed. */
  static readonly layer = (filename: string) =>
    Layer.effect(UsageHistory, make).pipe(
      Layer.provide(SqliteMigrator.layer({ loader: migrations })),
      Layer.provideMerge(SqliteClient.layer({ filename })),
    );

  /** A history that lasts only as long as the layer, for tests. */
  static readonly layerMemory = UsageHistory.layer(":memory:");
}
