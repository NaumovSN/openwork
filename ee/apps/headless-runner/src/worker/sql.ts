import type { SqlDriver } from "../sql.js"

/**
 * A SqlDriver over a SQLite-backed Durable Object's storage (Cloudflare Workers or celld). Every
 * cursor is drained before returning, because celld rejects a response or an outbound fetch while
 * an unfinished write cursor holds uncommitted rows.
 */
export function durableObjectSql(storage: DurableObjectStorage): SqlDriver {
  const { sql } = storage
  return {
    exec(query) {
      sql.exec(query).toArray()
    },
    get: (query, ...params) => sql.exec(query, ...params).toArray()[0],
    all: (query, ...params) => sql.exec(query, ...params).toArray(),
    run(query, ...params) {
      const cursor = sql.exec(query, ...params)
      cursor.toArray()
      return cursor.rowsWritten
    },
    transaction: (fn) => storage.transactionSync(fn),
    close() {},
  }
}
