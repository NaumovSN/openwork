import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { SqlDriver } from "./sql.js"

export type NodeSqlDriver = SqlDriver & { readonly db: DatabaseSync }

/** Every session in one SQLite file (WAL mode), for the Node server. */
export function nodeSqlite(path: string): NodeSqlDriver {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")
  return {
    db,
    exec: (sql) => db.exec(sql),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    run: (sql, ...params) => Number(db.prepare(sql).run(...params).changes),
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE")
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    close: () => db.close(),
  }
}
