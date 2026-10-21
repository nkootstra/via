import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { Migrator, SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { inDatabase, ownerOnly, scrubWal } from "./database.ts";
import { CapturedRequest } from "./entry.ts";

/** How long a captured request is kept: far less than the history, as it holds prompts. */
const RETENTION = Duration.days(7);

/** How often the captured requests are pruned, so none outlives its 7 days by much. */
const PRUNE_EVERY = Duration.hours(1);

const migrations = Migrator.fromRecord({
  // `request_id` names the request, as in the usage history, which a client's own
  // x-request-id can repeat. `capture` is the whole `CapturedRequest`, as JSON.
  "1_captured_requests": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE captured_requests (
        request_id TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        capture TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX captured_requests_request ON captured_requests (request_id, captured_at)`;
    yield* sql`CREATE INDEX captured_requests_captured ON captured_requests (captured_at)`;
  }),
});

const Stored = Schema.fromJsonString(CapturedRequest);

const encodeStored = Schema.encodeEffect(Stored);

const decodeStored = Schema.decodeUnknownEffect(Schema.Struct({ capture: Stored }));

const decodeIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ requestId: Schema.String })),
);

const decodeCount = Schema.decodeUnknownEffect(Schema.Struct({ n: Schema.Finite }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Counts the changes this process makes, so `changes` can signal each one.
  const revision = yield* SubscriptionRef.make(0);
  const bump = SubscriptionRef.update(revision, (n) => n + 1);

  const keep = Effect.fn("CapturedRequests.keep")(function* (captured: CapturedRequest) {
    // A captured request is built by via from JSON, so it always encodes.
    const capture = yield* encodeStored(captured).pipe(Effect.orDie);

    yield* sql`
      INSERT INTO captured_requests ${sql.insert({
        request_id: captured.requestId,
        captured_at: captured.capturedAt,
        capture,
      })}
    `;
  });

  /** The oldest a captured request can be and still be given back: the prune may not have run yet. */
  const keptSince = Effect.map(
    Clock.currentTimeMillis,
    (now) => now - Duration.toMillis(RETENTION),
  );

  const get = Effect.fn("CapturedRequests.get")(function* (requestId: string) {
    const since = yield* keptSince;
    const [row] = yield* sql`
      SELECT capture FROM captured_requests
      WHERE request_id = ${requestId} AND captured_at >= ${since}
      ORDER BY captured_at DESC, rowid DESC
      LIMIT 1
    `;

    if (row === undefined) return Option.none<CapturedRequest>();

    // Rows only ever come from `keep`, so they always decode.
    return Option.some((yield* decodeStored(row).pipe(Effect.orDie)).capture);
  });

  const which = Effect.fn("CapturedRequests.which")(function* (requestIds: ReadonlyArray<string>) {
    if (requestIds.length === 0) return [];

    const since = yield* keptSince;
    const rows = yield* sql`
      SELECT DISTINCT request_id AS "requestId" FROM captured_requests
      WHERE ${sql.in("request_id", requestIds)} AND captured_at >= ${since}
    `;

    // Rows only ever come from `keep`, so they always decode.
    const found = new Set((yield* decodeIds(rows).pipe(Effect.orDie)).map((row) => row.requestId));

    return requestIds.filter((id) => found.has(id));
  });

  const prune = Effect.gen(function* () {
    yield* sql`DELETE FROM captured_requests WHERE captured_at < ${yield* keptSince}`;
    yield* scrubWal(sql);
  }).pipe(Effect.withSpan("CapturedRequests.prune"));

  // At start and then every hour. A failed prune is only logged: the next one retries.
  yield* prune.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not prune the captured requests", cause)),
    Effect.repeat(Schedule.spaced(PRUNE_EVERY)),
    Effect.forkScoped,
  );

  const clear = Effect.gen(function* () {
    const [counted] = yield* sql`SELECT COUNT(*) AS n FROM captured_requests`;
    yield* sql`DELETE FROM captured_requests`;

    // A count of rows always decodes: SQLite answers COUNT(*) with a number.
    return (yield* decodeCount(counted).pipe(Effect.orDie)).n;
  }).pipe(
    sql.withTransaction,
    Effect.tap(() => scrubWal(sql)),
    Effect.withSpan("CapturedRequests.clear"),
  );

  const changes = SubscriptionRef.changes(revision).pipe(Stream.map(() => undefined));

  return {
    keep: (captured: CapturedRequest) => Effect.tap(keep(captured), bump),
    get,
    which,
    prune,
    clear: Effect.tap(clear, bump),
    changes,
  };
});

/**
 * The request bodies of turns that failed or fell back, redacted, kept while the setting
 * to keep them is on, for 7 days, in their own SQLite database next to the usage history.
 */
export class CapturedRequests extends Context.Service<
  CapturedRequests,
  {
    /** Keeps one captured request. */
    readonly keep: (captured: CapturedRequest) => Effect.Effect<void, SqlError>;
    /** The latest request captured with id `requestId` in the last 7 days, if any is. */
    readonly get: (requestId: string) => Effect.Effect<Option.Option<CapturedRequest>, SqlError>;
    /** Which of `requestIds` have a request captured in the last 7 days, in their order. */
    readonly which: (
      requestIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, SqlError>;
    /** Forgets requests captured more than 7 days ago; it also runs by itself every hour. */
    readonly prune: Effect.Effect<void, SqlError>;
    /** Forgets every captured request, and says how many there were. */
    readonly clear: Effect.Effect<number, SqlError>;
    /** Signals now, then after each request kept and each clear. */
    readonly changes: Stream.Stream<void>;
  }
>()("via/CapturedRequests") {
  private static readonly open = (filename: string) =>
    inDatabase(Layer.effect(CapturedRequests, make), filename, migrations);

  /** The captured requests in the SQLite database at `filename`, created owner-only as needed. */
  static readonly layer = (filename: string) =>
    CapturedRequests.open(filename).pipe(Layer.provide(ownerOnly(filename)));

  /** Captured requests that last only as long as the layer, for tests. */
  static readonly layerMemory = CapturedRequests.open(":memory:");
}
