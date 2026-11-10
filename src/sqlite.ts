import { DatabaseSync } from "node:sqlite";

/**
 * Litestream replicates the write-ahead log rather than the database file, so a store
 * that is not in WAL mode has nothing to stream and every write is lost on the next
 * cold boot. The test suite passes the literal `:memory:`, which has no journal file
 * to switch, so that one case is left alone.
 *
 * The paths here are the ones in `tools/litestream.yml` on purpose. An environment
 * override that points a store somewhere else moves it out of the backup without
 * saying so, which is why the deployed environment sets none of them.
 */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("pragma journal_mode = wal");
  return db;
}
