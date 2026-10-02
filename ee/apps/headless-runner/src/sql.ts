/** Values the store binds. Both node:sqlite and Durable Object SQL storage accept them. */
export type SqlValue = string | number | null

/**
 * The synchronous SQLite operations the store needs. Two implementations:
 * - `nodeSqlite` (node-sqlite.ts): one file for every session, used by the Node server.
 * - `durableObjectSql` (worker/sql.ts): one database per session, inside a Durable Object on
 *   Cloudflare Workers or celld.
 */
export type SqlDriver = {
  /** Runs one statement that returns no rows, such as a CREATE TABLE. */
  exec(sql: string): void
  get(sql: string, ...params: SqlValue[]): unknown
  all(sql: string, ...params: SqlValue[]): unknown[]
  /** Runs a write. Returns a count that is 0 when no row changed. */
  run(sql: string, ...params: SqlValue[]): number
  transaction<T>(fn: () => T): T
  close(): void
}
