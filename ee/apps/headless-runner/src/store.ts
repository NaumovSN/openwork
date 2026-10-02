import { z } from "zod"
import type { Usage } from "./model.js"
import type { SqlDriver } from "./sql.js"
import { ACTIVE, messageSchema, turnStatusSchema, type Message, type TurnStatus } from "./types.js"

const sessionRow = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
})
const turnRow = z.object({
  session_id: z.string(),
  message_id: z.string(),
  status: turnStatusSchema,
  model: z.string().nullable(),
  error: z.string().nullable(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  output_tokens: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
})
const messageRow = z.object({ seq: z.number(), message_id: z.string(), body: z.string() })
const fileRow = z.object({ path: z.string(), size: z.number(), updated_at: z.number() })
const countRow = z.object({ n: z.number() })

export type Session = { id: string; title: string; instructions: string; createdAt: number; updatedAt: number }
export type Turn = {
  sessionId: string
  messageId: string
  status: TurnStatus
  model: string | null
  error: string | null
  usage: Usage
  createdAt: number
  updatedAt: number
}
export type StoredMessage = { seq: number; messageId: string; message: Message }
export type FileEntry = { path: string; size: number; updatedAt: number }

function toTurn(row: unknown): Turn {
  const value = turnRow.parse(row)
  return {
    sessionId: value.session_id,
    messageId: value.message_id,
    status: value.status,
    model: value.model,
    error: value.error,
    usage: { inputTokens: value.input_tokens, cachedInputTokens: value.cached_input_tokens, outputTokens: value.output_tokens },
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT,
    error TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, path)
  )`,
]

const encoder = new TextEncoder()
/** UTF-8 byte length, without Node's Buffer. */
export const utf8Length = (text: string) => encoder.encode(text).byteLength

export type StoreOptions = {
  now?: () => number
  /** Id for the next new session. A Durable Object holds one session and passes its own name. */
  sessionId?: () => string
}

/**
 * Durable session state behind a SqlDriver: one SQLite file for the Node server, or one Durable
 * Object database per session. Every transcript step is written before the next one starts, so a
 * crash loses at most the in-flight step.
 */
export class Store {
  private readonly now: () => number
  private readonly nextSessionId: () => string

  constructor(
    readonly sql: SqlDriver,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.nextSessionId = options.sessionId ?? (() => `hs_${crypto.randomUUID().replaceAll("-", "")}`)
    this.migrate()
  }

  /** Creates the tables when they are missing. */
  migrate() {
    for (const statement of SCHEMA) this.sql.exec(statement)
  }

  close() {
    this.sql.close()
  }

  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn)
  }

  createSession(input: { title?: string; instructions?: string }): Session {
    const at = this.now()
    const session = {
      id: this.nextSessionId(),
      title: input.title ?? "Untitled",
      instructions: input.instructions ?? "",
      createdAt: at,
      updatedAt: at,
    }
    this.sql.run(
      "INSERT INTO sessions (id, title, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      session.id,
      session.title,
      session.instructions,
      at,
      at,
    )
    return session
  }

  getSession(id: string): Session | null {
    const row = this.sql.get("SELECT * FROM sessions WHERE id = ?", id)
    if (!row) return null
    const value = sessionRow.parse(row)
    return {
      id: value.id,
      title: value.title,
      instructions: value.instructions,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }

  /** Deletes the session and everything in it, without relying on foreign-key cascades. */
  deleteSession(id: string) {
    return this.transaction(() => {
      for (const table of ["files", "messages", "turns"]) this.sql.run(`DELETE FROM ${table} WHERE session_id = ?`, id)
      return this.sql.run("DELETE FROM sessions WHERE id = ?", id) > 0
    })
  }

  getTurn(sessionId: string, messageId: string): Turn | null {
    const row = this.sql.get("SELECT * FROM turns WHERE session_id = ? AND message_id = ?", sessionId, messageId)
    return row ? toTurn(row) : null
  }

  listTurns(sessionId: string): Turn[] {
    return this.sql.all("SELECT * FROM turns WHERE session_id = ? ORDER BY created_at, rowid", sessionId).map(toTurn)
  }

  activeTurn(sessionId: string): Turn | null {
    return this.listTurns(sessionId).find((turn) => ACTIVE.has(turn.status)) ?? null
  }

  /**
   * Records the turn and its prompt. The user message joins the transcript only
   * when the turn starts, so a follow-up queued behind a running turn is never
   * interleaved into that turn's transcript.
   */
  admitTurn(input: { sessionId: string; messageId: string; prompt: string; model: string | null }): Turn {
    const at = this.now()
    this.sql.run(
      "INSERT INTO turns (session_id, message_id, status, prompt, model, error, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, NULL, ?, ?)",
      input.sessionId,
      input.messageId,
      input.prompt,
      input.model,
      at,
      at,
    )
    const turn = this.getTurn(input.sessionId, input.messageId)
    if (!turn) throw new Error("turn_admission_failed")
    return turn
  }

  /** Appends the turn's user message the first time the turn starts. */
  startTranscript(sessionId: string, messageId: string) {
    this.transaction(() => {
      const existing = this.sql.get("SELECT 1 AS n FROM messages WHERE session_id = ? AND message_id = ? LIMIT 1", sessionId, messageId)
      if (existing) return
      const row = this.sql.get("SELECT prompt FROM turns WHERE session_id = ? AND message_id = ?", sessionId, messageId)
      if (!row) throw new Error("unknown_turn")
      this.appendMessage(sessionId, messageId, { role: "user", text: z.object({ prompt: z.string() }).parse(row).prompt })
    })
  }

  setTurnStatus(sessionId: string, messageId: string, status: TurnStatus, error: string | null = null) {
    const at = this.now()
    this.sql.run("UPDATE turns SET status = ?, error = ?, updated_at = ? WHERE session_id = ? AND message_id = ?", status, error, at, sessionId, messageId)
    this.sql.run("UPDATE sessions SET updated_at = ? WHERE id = ?", at, sessionId)
  }

  addUsage(sessionId: string, messageId: string, usage: Usage) {
    this.sql.run(
      `UPDATE turns SET input_tokens = input_tokens + ?, cached_input_tokens = cached_input_tokens + ?,
       output_tokens = output_tokens + ? WHERE session_id = ? AND message_id = ?`,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      sessionId,
      messageId,
    )
  }

  /** Marks every turn a previous process left queued or running as interrupted. */
  recoverInterruptedTurns() {
    return this.sql.run(
      "UPDATE turns SET status = 'interrupted', error = 'runner_restarted', updated_at = ? WHERE status IN ('queued', 'running')",
      this.now(),
    )
  }

  appendMessage(sessionId: string, messageId: string, message: Message) {
    const row = countRow.parse(this.sql.get("SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE session_id = ?", sessionId))
    this.sql.run(
      "INSERT INTO messages (session_id, seq, message_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      sessionId,
      row.n + 1,
      messageId,
      JSON.stringify(messageSchema.parse(message)),
      this.now(),
    )
  }

  messages(sessionId: string): StoredMessage[] {
    return this.sql
      .all("SELECT seq, message_id, body FROM messages WHERE session_id = ? ORDER BY seq", sessionId)
      .map((row) => {
        const value = messageRow.parse(row)
        return { seq: value.seq, messageId: value.message_id, message: messageSchema.parse(JSON.parse(value.body)) }
      })
  }

  listFiles(sessionId: string): FileEntry[] {
    return this.sql
      .all("SELECT path, size, updated_at FROM files WHERE session_id = ? ORDER BY path", sessionId)
      .map((row) => {
        const value = fileRow.parse(row)
        return { path: value.path, size: value.size, updatedAt: value.updated_at }
      })
  }

  readFile(sessionId: string, path: string): string | null {
    const row = this.sql.get("SELECT content FROM files WHERE session_id = ? AND path = ?", sessionId, path)
    return row ? z.object({ content: z.string() }).parse(row).content : null
  }

  writeFile(sessionId: string, path: string, content: string) {
    this.sql.run(
      `INSERT INTO files (session_id, path, content, size, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id, path) DO UPDATE SET content = excluded.content, size = excluded.size, updated_at = excluded.updated_at`,
      sessionId,
      path,
      content,
      utf8Length(content),
      this.now(),
    )
  }

  deleteFile(sessionId: string, path: string) {
    return this.sql.run("DELETE FROM files WHERE session_id = ? AND path = ?", sessionId, path) > 0
  }
}
