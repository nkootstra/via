import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { dirname } from "node:path";
import { UsageEntry } from "./entry.ts";
import { Migrator, SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

/** Where a page of the request list starts: just after this request. */
interface RequestCursor {
  readonly at: number;
  readonly requestId: string;
}

/**
 * Whether a request failed: an error status, other than a client giving up
 * (499), or a stream that broke off.
 */
type Outcome = "ok" | "error";

/**
 * What narrows a query to some requests: a model, an account, a key, an
 * outcome, and whether another model answered for the one asked for. An
 * account is named as the breakdown names it, so `provider:<name>` is the
 * requests of that provider no account served.
 */
interface Filters {
  readonly model?: string | undefined;
  readonly accountId?: string | undefined;
  readonly keyId?: string | undefined;
  readonly outcome?: Outcome | undefined;
  readonly fellBack?: boolean | undefined;
}

export interface RequestQuery extends Filters {
  readonly from: number;
  readonly to: number;
  readonly limit: number;
  readonly cursor?: RequestCursor | undefined;
}

export interface RequestPage {
  readonly requests: ReadonlyArray<UsageEntry>;
  /** Where the next page starts, when there is one. */
  readonly next: Option.Option<RequestCursor>;
}

/**
 * What usage is totalled by. A request no account served, as one a plain
 * provider answered or one via turned away, counts under `provider:<name>`
 * when grouped by account.
 */
export type GroupBy = "model" | "account" | "key" | "provider";

export interface SeriesQuery extends Filters {
  readonly from: number;
  readonly to: number;
  readonly bucket: "hour" | "day";
  /** The viewer's time zone, whose midnights start the days and whose hours start the hours. */
  readonly timeZone: DateTime.TimeZone;
  readonly groupBy: GroupBy;
}

/** Token sums, 0 where no request reported any. */
const TokenSums = {
  inputTokens: Schema.Finite,
  cachedTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  reasoningTokens: Schema.Finite,
};

/** One group's usage in one bucket of time. */
const SeriesPoint = Schema.Struct({
  /** When the bucket starts, in epoch milliseconds. */
  bucket: Schema.Finite,
  group: Schema.String,
  requests: Schema.Finite,
  /** How many of `requests` reported their usage; the sums leave out the rest. */
  measured: Schema.Finite,
  ...TokenSums,
});

export type SeriesPoint = typeof SeriesPoint.Type;

export interface BreakdownQuery extends Filters {
  readonly from: number;
  readonly to: number;
  readonly groupBy: GroupBy;
}

/** The median and 95th percentile of a timing, by nearest rank; none without any timings. */
export interface Percentiles {
  readonly p50: Option.Option<number>;
  readonly p95: Option.Option<number>;
}

/**
 * One model's part of a group, split for pricing: what upstreams billed, and
 * the tokens of the requests they didn't bill, for via to price itself.
 */
export interface ModelUsage {
  readonly model: string;
  readonly billedUsd: number;
  readonly billedRequests: number;
  readonly unbilled: {
    readonly inputTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
  };
}

export interface GroupUsage {
  readonly group: string;
  /** The group's name as its latest request had it: a model, account label, key name or provider. */
  readonly label: string;
  readonly requests: number;
  /** Requests that failed, as `Outcome` defines it. */
  readonly errors: number;
  /** Requests another model answered because the one asked for couldn't serve. */
  readonly fellBack: number;
  readonly measured: number;
  /** Answered requests that reported no usage, which the token sums leave out; failed ones have none to report. */
  readonly unmeasured: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly firstChunkMs: Percentiles;
  readonly models: ReadonlyArray<ModelUsage>;
}

export interface Breakdown {
  /** The groups, the most requested first. */
  readonly groups: ReadonlyArray<GroupUsage>;
  /** Over every request in the range. */
  readonly firstChunkMs: Percentiles;
}

const ModelRow = Schema.Struct({
  group: Schema.String,
  label: Schema.String,
  model: Schema.String,
  lastAt: Schema.Finite,
  requests: Schema.Finite,
  errors: Schema.Finite,
  fellBack: Schema.Finite,
  measured: Schema.Finite,
  unmeasured: Schema.Finite,
  ...TokenSums,
  billedUsd: Schema.Finite,
  billedRequests: Schema.Finite,
  unbilledInput: Schema.Finite,
  unbilledCached: Schema.Finite,
  unbilledCacheWrite: Schema.Finite,
  unbilledOutput: Schema.Finite,
});

const PercentileRow = Schema.Struct({
  group: Schema.String,
  p50: Schema.OptionFromNullOr(Schema.Finite),
  p95: Schema.OptionFromNullOr(Schema.Finite),
});

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(UsageEntry));

const decodePoints = Schema.decodeUnknownEffect(Schema.Array(SeriesPoint));

const decodeModelRows = Schema.decodeUnknownEffect(Schema.Array(ModelRow));

const decodePercentiles = Schema.decodeUnknownEffect(Schema.Array(PercentileRow));

const decodeCount = Schema.decodeUnknownEffect(Schema.Struct({ n: Schema.Finite }));

const HOUR_MS = 60 * 60 * 1000;

/**
 * The slots requests are first totalled in. Every time zone's offset is a whole
 * number of quarter hours, and the clocks change on a quarter hour, so every
 * hour and day starts on one. (Antarctica/Casey changes a minute past; that
 * minute's requests count in the hour before.)
 */
const SLOT_MS = 15 * 60 * 1000;

/** `n` modulo `size`, never negative. */
const modulo = (n: number, size: number) => ((n % size) + size) % size;

/** How far ahead of UTC the clocks in `zone` are at `at`, in milliseconds. */
const offsetAt = (at: number, zone: DateTime.TimeZone) =>
  DateTime.zonedOffset(DateTime.makeZonedUnsafe(at, { timeZone: zone }));

/** The first slot after `from`, up to `to`, where the clocks in `zone` change; `to` without one. */
const changeAfter = (from: number, to: number, zone: DateTime.TimeZone) => {
  const offset = offsetAt(from, zone);
  let at = from - modulo(from, SLOT_MS) + SLOT_MS;

  while (at < to && offsetAt(at, zone) === offset) at += SLOT_MS;

  return Math.min(at, to);
};

/**
 * When the hour or day that holds `at` starts in `zone`. A day starts at local
 * midnight, so it can last 23 or 25 hours. An hour starts on the hour of the
 * local clock, or when the clocks change: the hour a clock repeats when summer
 * time ends is two, and a change of half an hour leaves a half hour.
 */
const bucketStart = (at: number, bucket: SeriesQuery["bucket"], zone: DateTime.TimeZone) => {
  if (bucket === "day") {
    const local = DateTime.makeZonedUnsafe(at, { timeZone: zone });

    return DateTime.toEpochMillis(DateTime.startOf(local, "day"));
  }

  const offset = offsetAt(at, zone);
  const onTheHour = at - modulo(at + offset, HOUR_MS);

  return offsetAt(onTheHour, zone) === offset ? onTheHour : changeAfter(onTheHour, at, zone);
};

/** When the hour or day after the one starting at `start` starts in `zone`. */
const nextStart = (start: number, bucket: SeriesQuery["bucket"], zone: DateTime.TimeZone) => {
  if (bucket === "hour") {
    const offset = offsetAt(start, zone);
    const onTheHour = start + HOUR_MS - modulo(start + offset, HOUR_MS);

    return offsetAt(onTheHour, zone) === offset ? onTheHour : changeAfter(start, onTheHour, zone);
  }

  // A day later on the clock: a day is a step of the calendar, not 24 hours.
  const local = DateTime.makeZonedUnsafe(start, { timeZone: zone });

  return DateTime.toEpochMillis(DateTime.startOf(DateTime.add(local, { days: 1 }), "day"));
};

/**
 * The starts of the hours or days in `zone` from the one that holds `first`
 * up to and including the one after `last`, which ends the last bucket.
 */
const bucketStarts = (
  first: number,
  last: number,
  bucket: SeriesQuery["bucket"],
  zone: DateTime.TimeZone,
) => {
  let start = bucketStart(first, bucket, zone);
  const starts = [start];

  while (start <= last) {
    start = nextStart(start, bucket, zone);
    starts.push(start);
  }

  return starts;
};

/**
 * Folds `slots`, oldest first, into the hours or days of `zone` that hold
 * them: their counts and sums add up.
 */
const intoBuckets = (
  slots: ReadonlyArray<SeriesPoint>,
  bucket: SeriesQuery["bucket"],
  zone: DateTime.TimeZone,
) => {
  const first = slots[0];
  const last = slots.at(-1);

  if (first === undefined || last === undefined) return [];

  const starts = bucketStarts(first.bucket, last.bucket, bucket, zone);
  const points = new Map<string, SeriesPoint>();
  let index = 0;

  for (const slot of slots) {
    while ((starts[index + 1] ?? Infinity) <= slot.bucket) index += 1;

    const start = starts[index] ?? slot.bucket;
    const id = `${start} ${slot.group}`;
    const sum = points.get(id);

    points.set(
      id,
      sum === undefined
        ? { ...slot, bucket: start }
        : {
            bucket: start,
            group: slot.group,
            requests: sum.requests + slot.requests,
            measured: sum.measured + slot.measured,
            inputTokens: sum.inputTokens + slot.inputTokens,
            cachedTokens: sum.cachedTokens + slot.cachedTokens,
            outputTokens: sum.outputTokens + slot.outputTokens,
            reasoningTokens: sum.reasoningTokens + slot.reasoningTokens,
          },
    );
  }

  return [...points.values()].toSorted((a, b) =>
    a.bucket === b.bucket ? (a.group < b.group ? -1 : 1) : a.bucket - b.bucket,
  );
};

const noPercentiles: Percentiles = { p50: Option.none(), p95: Option.none() };

/** How long a request is kept. */
const RETENTION = Duration.days(90);

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
  "2_error_message": Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`ALTER TABLE requests ADD COLUMN error_message TEXT`,
  ),
  "3_cache_write_tokens": Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`ALTER TABLE requests ADD COLUMN cache_write_tokens INTEGER`,
  ),
  "4_fallbacks": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE requests ADD COLUMN requested_model TEXT`;
    yield* sql`ALTER TABLE requests ADD COLUMN fallback_reason TEXT`;
  }),
  // An older via kept an upstream's error message, which can quote the request it refused, and
  // its code, which can be any text. Its messages can't be told from via's own, so none is kept;
  // a code or fallback reason is kept only as the identifier the server now keeps one as.
  "5_no_upstream_words": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /** Whether `column` holds something other than an identifier, as `^[A-Za-z0-9_.:-]{1,64}$`. */
    const notACode = (column: string) =>
      sql`${sql(column)} IS NOT NULL AND (length(${sql(column)}) NOT BETWEEN 1 AND 64 OR ${sql(column)} GLOB '*[^A-Za-z0-9_.:-]*')`;

    yield* sql`UPDATE requests SET error_message = NULL WHERE error_message IS NOT NULL`;
    yield* sql`UPDATE requests SET error = NULL WHERE ${notACode("error")}`;
    yield* sql`UPDATE requests SET fallback_reason = NULL WHERE ${notACode("fallback_reason")}`;
  }),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Counts the changes this process makes, so `changes` can signal each one.
  const revision = yield* SubscriptionRef.make(0);
  const bump = SubscriptionRef.update(revision, (n) => n + 1);

  /**
   * The SQL condition for a failed request, as `Outcome` defines it. `IS`, not `=`: a
   * request without a stream has no `stream_end`, and `NOT` of a NULL would drop it.
   */
  const failed = sql`((status >= 400 AND status <> 499) OR stream_end IS 'failed')`;

  /** The provider an account filter names instead of an account, as `provider:<name>`. */
  const PROVIDER_GROUP = "provider:";

  /** The SQL condition for the requests in `[from, to)` that `filters` keep. */
  const matching = (query: Filters & { readonly from: number; readonly to: number }) =>
    sql.and([
      sql`at >= ${query.from}`,
      sql`at < ${query.to}`,
      ...(query.model === undefined ? [] : [sql`model = ${query.model}`]),
      ...(query.accountId === undefined
        ? []
        : query.accountId.startsWith(PROVIDER_GROUP)
          ? [
              sql`account_id IS NULL`,
              sql`provider = ${query.accountId.slice(PROVIDER_GROUP.length)}`,
            ]
          : [sql`account_id = ${query.accountId}`]),
      ...(query.keyId === undefined ? [] : [sql`key_id = ${query.keyId}`]),
      ...(query.outcome === undefined
        ? []
        : [query.outcome === "error" ? failed : sql`NOT ${failed}`]),
      ...(query.fellBack === undefined
        ? []
        : [query.fellBack ? sql`requested_model IS NOT NULL` : sql`requested_model IS NULL`]),
    ]);

  const columns = sql`
    request_id AS "requestId", at, status, error, error_message AS "errorMessage",
    stream_end AS "streamEnd",
    key_id AS "keyId", key_name AS "keyName", model, provider,
    account_id AS "accountId", account_label AS "accountLabel",
    input_tokens AS "inputTokens", cached_tokens AS "cachedTokens",
    cache_write_tokens AS "cacheWriteTokens",
    output_tokens AS "outputTokens", reasoning_tokens AS "reasoningTokens",
    cost_usd AS "costUsd", duration_ms AS "durationMs", first_chunk_ms AS "firstChunkMs",
    requested_model AS "requestedModel", fallback_reason AS "fallbackReason"
  `;

  const record = Effect.fn("UsageHistory.record")(function* (entry: UsageEntry) {
    // `entry` is already typed as the schema's Type, so encoding can only fail on a programming error.
    const row = yield* encodeEntry(entry).pipe(Effect.orDie);

    yield* sql`INSERT INTO requests ${sql.insert({
      request_id: row.requestId,
      at: row.at,
      status: row.status,
      error: row.error,
      error_message: row.errorMessage,
      stream_end: row.streamEnd,
      key_id: row.keyId,
      key_name: row.keyName,
      model: row.model,
      provider: row.provider,
      account_id: row.accountId,
      account_label: row.accountLabel,
      input_tokens: row.inputTokens,
      cached_tokens: row.cachedTokens,
      cache_write_tokens: row.cacheWriteTokens,
      output_tokens: row.outputTokens,
      reasoning_tokens: row.reasoningTokens,
      cost_usd: row.costUsd,
      duration_ms: row.durationMs,
      first_chunk_ms: row.firstChunkMs,
      requested_model: row.requestedModel,
      fallback_reason: row.fallbackReason,
    })}`;
  });

  const requests = Effect.fn("UsageHistory.requests")(function* (query: RequestQuery) {
    const where = sql.and([
      matching(query),
      ...(query.cursor === undefined
        ? []
        : [
            sql`(at < ${query.cursor.at} OR (at = ${query.cursor.at} AND request_id < ${query.cursor.requestId}))`,
          ]),
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

  /** The SQL expressions for a grouping's key and its name. */
  const grouping = (groupBy: GroupBy) => {
    switch (groupBy) {
      case "model":
        return { key: sql`model`, label: sql`model` };
      case "provider":
        return { key: sql`provider`, label: sql`provider` };
      case "key":
        return { key: sql`COALESCE(key_id, '')`, label: sql`COALESCE(key_name, key_id, '')` };
      case "account":
        return {
          key: sql`COALESCE(account_id, 'provider:' || provider)`,
          label: sql`COALESCE(account_label, account_id, provider)`,
        };
    }
  };

  const series = Effect.fn("UsageHistory.series")(function* (query: SeriesQuery) {
    const { key } = grouping(query.groupBy);

    // SQLite knows no time zones, so it totals each quarter-hour slot, in one pass
    // over the requests, and the slots are folded into the viewer's hours or days.
    // `%` truncates toward zero, so the remainder is made non-negative first.
    const rows = yield* sql`
      SELECT
        at - ((at % ${SLOT_MS}) + ${SLOT_MS}) % ${SLOT_MS} AS bucket,
        ${key} AS "group",
        COUNT(*) AS requests,
        COUNT(input_tokens) AS measured,
        COALESCE(SUM(input_tokens), 0) AS "inputTokens",
        COALESCE(SUM(cached_tokens), 0) AS "cachedTokens",
        COALESCE(SUM(output_tokens), 0) AS "outputTokens",
        COALESCE(SUM(reasoning_tokens), 0) AS "reasoningTokens"
      FROM requests
      WHERE ${matching(query)}
      GROUP BY bucket, "group"
      ORDER BY bucket, "group"
    `;

    // Rows only ever come from this query, so they always decode.
    const slots = yield* decodePoints(rows).pipe(Effect.orDie);

    return intoBuckets(slots, query.bucket, query.timeZone);
  });

  /** The first-chunk percentiles of each group of `key`, by nearest rank, of answered requests only. */
  const percentiles = (query: BreakdownQuery, key: ReturnType<typeof grouping>["key"]) =>
    Effect.flatMap(
      sql`
        WITH ranked AS (
          SELECT
            ${key} AS "group",
            first_chunk_ms AS ms,
            ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY first_chunk_ms) AS rank,
            COUNT(*) OVER (PARTITION BY ${key}) AS n
          FROM requests
          -- An error that answers at once says nothing of how soon a model starts answering.
          WHERE ${matching(query)} AND first_chunk_ms IS NOT NULL
            AND NOT ${failed}
        )
        SELECT
          "group",
          MIN(CASE WHEN rank >= 0.5 * n THEN ms END) AS p50,
          MIN(CASE WHEN rank >= 0.95 * n THEN ms END) AS p95
        FROM ranked
        GROUP BY "group"
      `,
      // Rows only ever come from this query, so they always decode.
      (rows) => decodePercentiles(rows).pipe(Effect.orDie),
    );

  const breakdown = Effect.fn("UsageHistory.breakdown")(function* (query: BreakdownQuery) {
    const { key, label } = grouping(query.groupBy);

    // `label` is a bare column beside the one MAX(at), so SQLite takes it from the latest request.
    const rows = yield* sql`
      SELECT
        ${key} AS "group",
        ${label} AS label,
        model,
        MAX(at) AS "lastAt",
        COUNT(*) AS requests,
        COALESCE(SUM(${failed}), 0) AS errors,
        COUNT(requested_model) AS "fellBack",
        COUNT(input_tokens) AS measured,
        COALESCE(SUM(CASE WHEN input_tokens IS NULL AND NOT ${failed} THEN 1 ELSE 0 END), 0)
          AS unmeasured,
        COALESCE(SUM(input_tokens), 0) AS "inputTokens",
        COALESCE(SUM(cached_tokens), 0) AS "cachedTokens",
        COALESCE(SUM(output_tokens), 0) AS "outputTokens",
        COALESCE(SUM(reasoning_tokens), 0) AS "reasoningTokens",
        COALESCE(SUM(cost_usd), 0) AS "billedUsd",
        COUNT(cost_usd) AS "billedRequests",
        COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN input_tokens END), 0) AS "unbilledInput",
        COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN cached_tokens END), 0) AS "unbilledCached",
        COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN cache_write_tokens END), 0)
          AS "unbilledCacheWrite",
        COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN output_tokens END), 0) AS "unbilledOutput"
      FROM requests
      WHERE ${matching(query)}
      GROUP BY "group", model
    `.pipe(
      // Rows only ever come from this query, so they always decode.
      Effect.flatMap((found) => decodeModelRows(found).pipe(Effect.orDie)),
    );

    const byGroup = new Map(
      (yield* percentiles(query, key)).map((row) => [row.group, { p50: row.p50, p95: row.p95 }]),
    );

    const [overall] = yield* percentiles(query, sql`''`);
    const groups = new Map<string, Array<typeof ModelRow.Type>>();

    for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);

    const totalled = [...groups].map(([group, models]): GroupUsage => {
      const total = (
        field:
          | "requests"
          | "errors"
          | "fellBack"
          | "measured"
          | "unmeasured"
          | keyof typeof TokenSums,
      ) => models.reduce((sum, row) => sum + row[field], 0);

      const latest = models.reduce((a, b) => (b.lastAt > a.lastAt ? b : a));

      return {
        group,
        label: latest.label,
        requests: total("requests"),
        errors: total("errors"),
        fellBack: total("fellBack"),
        measured: total("measured"),
        unmeasured: total("unmeasured"),
        inputTokens: total("inputTokens"),
        cachedTokens: total("cachedTokens"),
        outputTokens: total("outputTokens"),
        reasoningTokens: total("reasoningTokens"),
        firstChunkMs: byGroup.get(group) ?? noPercentiles,
        models: models.map((row) => ({
          model: row.model,
          billedUsd: row.billedUsd,
          billedRequests: row.billedRequests,
          unbilled: {
            inputTokens: row.unbilledInput,
            cachedTokens: row.unbilledCached,
            cacheWriteTokens: row.unbilledCacheWrite,
            outputTokens: row.unbilledOutput,
          },
        })),
      };
    });

    return {
      groups: totalled.toSorted((a, b) => b.requests - a.requests),
      firstChunkMs: overall === undefined ? noPercentiles : { p50: overall.p50, p95: overall.p95 },
    } satisfies Breakdown;
  });

  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM requests WHERE at < ${now - Duration.toMillis(RETENTION)}`;
  }).pipe(Effect.withSpan("UsageHistory.prune"));

  // At start and then once a day. A failed prune is only logged: the next one retries.
  yield* prune.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not prune the usage history", cause)),
    Effect.repeat(Schedule.spaced(Duration.days(1))),
    Effect.forkScoped,
  );

  const clear = Effect.gen(function* () {
    const [counted] = yield* sql`SELECT COUNT(*) AS n FROM requests`;
    yield* sql`DELETE FROM requests`;

    // A count of rows always decodes: SQLite answers COUNT(*) with a number.
    return (yield* decodeCount(counted).pipe(Effect.orDie)).n;
  }).pipe(sql.withTransaction, Effect.withSpan("UsageHistory.clear"));

  const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

  return {
    record: (entry: UsageEntry) => Effect.tap(record(entry), bump),
    requests,
    series,
    breakdown,
    prune,
    clear: Effect.tap(clear, bump),
    changes,
  };
});

/**
 * Creates the database file, owner-only, before SQLite opens it: SQLite would
 * create it with the umask's mode, and gives its WAL files the mode of the database.
 */
const createOwnerOnly = Effect.fn("UsageHistory.createOwnerOnly")(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(filename), { recursive: true, mode: 0o700 });

  if (!(yield* fs.exists(filename))) {
    yield* fs.writeFile(filename, new Uint8Array(), { flag: "wx", mode: 0o600 }).pipe(
      // Another process may have created the database since the existence check.
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
    );
  }

  yield* fs.chmod(filename, 0o600);
});

/** Every request via has served, kept in SQLite so it outlives a restart. */
export class UsageHistory extends Context.Service<
  UsageHistory,
  {
    /** Keeps one finished request. */
    readonly record: (entry: UsageEntry) => Effect.Effect<void, SqlError>;
    /** A page of the requests in `[from, to)`, newest first. */
    readonly requests: (query: RequestQuery) => Effect.Effect<RequestPage, SqlError>;
    /** Each group's usage per hour or day in `[from, to)`, oldest first. */
    readonly series: (query: SeriesQuery) => Effect.Effect<ReadonlyArray<SeriesPoint>, SqlError>;
    /** Each group's usage over `[from, to)`. */
    readonly breakdown: (query: BreakdownQuery) => Effect.Effect<Breakdown, SqlError>;
    /** Forgets requests older than 90 days; it also runs by itself once a day. */
    readonly prune: Effect.Effect<void, SqlError>;
    /** Forgets every request, and says how many there were. */
    readonly clear: Effect.Effect<number, SqlError>;
    /**
     * Signals now, then after each request kept and each clear, for a page that
     * shows the history to fetch it again. A prune signals nothing: it only
     * drops what a page no longer shows.
     */
    readonly changes: Stream.Stream<void>;
  }
>()("via/UsageHistory") {
  /**
   * The history in SQLite's `filename`, migrated as needed; `:memory:` lasts only as long as the
   * layer. What it deletes or clears, the migrations included, is overwritten, not left in the
   * file's free space: SQLite does that only with `secure_delete`, which is off by default on Linux.
   */
  private static readonly open = (filename: string) =>
    Layer.effect(UsageHistory, make).pipe(
      Layer.provide(SqliteMigrator.layer({ loader: migrations })),
      Layer.provide(
        Layer.effectDiscard(
          Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA secure_delete = ON`),
        ),
      ),
      Layer.provide(SqliteClient.layer({ filename })),
    );

  /** The history in the SQLite database at `filename`, created owner-only as needed. */
  static readonly layer = (filename: string) =>
    UsageHistory.open(filename).pipe(Layer.provide(Layer.effectDiscard(createOwnerOnly(filename))));

  /** A history that lasts only as long as the layer, for tests. */
  static readonly layerMemory = UsageHistory.open(":memory:");
}
