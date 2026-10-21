import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, FileSystem, Layer } from "effect";
import { dirname } from "node:path";
import { type Migrator, SqlClient } from "effect/sql";

/**
 * Creates the database file, owner-only, before SQLite opens it: SQLite would
 * create it with the umask's mode, and gives its WAL files the mode of the database.
 */
const createOwnerOnly = Effect.fn("createOwnerOnly")(function* (filename: string) {
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

/** Creates SQLite's `filename` owner-only, as needed, before a layer opens it. */
export const ownerOnly = (filename: string) => Layer.effectDiscard(createOwnerOnly(filename));

/**
 * Moves the WAL into the database and empties it, after a delete: `secure_delete` overwrites
 * a deleted row in the database, but the WAL still holds the pages written before it, the row
 * in them, until SQLite reuses them.
 */
export const scrubWal = (sql: SqlClient.SqlClient) =>
  Effect.asVoid(sql`PRAGMA wal_checkpoint(TRUNCATE)`);

/**
 * `service`, given SQLite's `filename`, migrated by `loader` as needed; `:memory:` lasts only
 * as long as the layer. What it deletes, the migrations included, is overwritten, not left in
 * the file's free space: SQLite does that only with `secure_delete`, which is off by default on
 * Linux.
 */
export const inDatabase = <A, E, R>(
  service: Layer.Layer<A, E, R>,
  filename: string,
  loader: Migrator.Loader,
) =>
  service.pipe(
    Layer.provide(SqliteMigrator.layer({ loader })),
    Layer.provide(
      Layer.effectDiscard(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA secure_delete = ON`),
      ),
    ),
    Layer.provide(SqliteClient.layer({ filename })),
  );
