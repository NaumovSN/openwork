import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../openapi.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator, type OrganizationContextVariables } from "../middleware/index.js"
import type { AuthContextVariables } from "../session.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import { streamSSE } from "hono/streaming"
import { toWorkbotPageEvent } from "@openwork-ee/workbot-server"
import { workbot, workbotEnabled, WorkbotFilesUnavailableError, WorkbotUnavailableError, type WorkbotActor } from "./service.js"

// The page talks to these; an agent never should, so none of them is an MCP operation.
type WorkbotRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeWorkbotRoute = (options: WorkbotRouteOptions) => describeRoute(options)

const stepSchema = z.object({
  label: z.string(),
  icon: z.enum(["app", "file", "dot", "computer"]),
  status: z.enum(["running", "done", "error"]),
  app: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  updates: z.array(z.string()),
})
const partSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("steps"), steps: z.array(stepSchema) }),
])
const turnSchema = z.object({
  id: z.string(),
  text: z.string(),
  sentAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  status: z.enum(["queued", "working", "done", "failed", "stopped"]),
  attachments: z.array(z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number() })),
  outputs: z.array(z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number(), updatedAt: z.number().optional() })),
  parts: z.array(partSchema),
  modelSteps: z.number(),
  error: z.string().nullable(),
}).meta({ ref: "WorkbotTurn" })
const workbotResponseSchema = z.union([
  z.object({ available: z.literal(false), reason: z.enum(["workbot_not_enabled", "workbot_runner_unavailable"]) }),
  z.object({
    available: z.literal(true),
    name: z.string(),
    organizationName: z.string(),
    status: z.enum(["idle", "busy"]),
    turns: z.array(turnSchema),
    hasEarlier: z.boolean(),
    filesEnabled: z.boolean(),
  }),
]).meta({ ref: "WorkbotThread" })
const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  source: z.enum(["user", "agent"]),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
}).meta({ ref: "WorkbotFile" })
const fileIdSchema = z.string().regex(/^fl_[a-f0-9]{32}$/)
const uploadQuerySchema = z.object({ name: z.string().trim().min(1).max(255), timeZone: z.string().max(64).optional() })
/** Raster images open inline (thumbnails); everything else always downloads, so no file renders as a page. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const threadQuerySchema = z.object({ turns: z.coerce.number().int().min(1).max(200).optional() })

/**
 * The stream ends after this and the page reopens it: a held-open stream never outlives a membership change
 * for long, and it ends cleanly before the web proxy's own deadline (175 seconds).
 */
const EVENTS_MAX_MS = 170_000

const sendSchema = z.object({
  /** The page's id for this message; resending it never starts a second answer. */
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  text: z.string().trim().max(20_000),
  timeZone: z.string().max(64).optional(),
  /** Ids of files uploaded with POST /v1/workbot/files. */
  attachments: z.array(fileIdSchema).optional(),
}).strict()

/** Plenty for a person typing; stops a runaway script from spending the organization's model budget. */
const MESSAGES_PER_WINDOW = 30
const MESSAGE_WINDOW_MS = 10 * 60_000

type Variables = AuthContextVariables & Partial<OrganizationContextVariables>

function actorOf(c: { get(key: "organizationContext"): Variables["organizationContext"]; get(key: "user"): Variables["user"] }): WorkbotActor | null {
  const context = c.get("organizationContext")
  if (!context) return null
  const name = c.get("user")?.name?.trim()
  return {
    organizationId: context.organization.id,
    organizationName: context.organization.name,
    organizationMetadata: context.organization.metadata,
    memberId: context.currentMember.id,
    userId: context.currentMember.userId,
    firstName: name ? name.split(/\s+/)[0] ?? null : null,
  }
}

const unavailable = (code: WorkbotUnavailableError["code"]) => ({ available: false as const, reason: code })

export function registerWorkbotRoutes<T extends { Variables: Variables }>(app: Hono<T>) {
  app.get(
    "/v1/workbot",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "getWorkbotThread",
      "x-mcp": false,
      summary: "Read my Workbot conversation",
      description: "The signed-in member's one Workbot conversation: the newest turns (30 unless `turns` asks for more), their messages and answers.",
      responses: {
        200: jsonResponse("The conversation, or why Workbot is unavailable.", workbotResponseSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(threadQuerySchema),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json(unavailable("workbot_not_enabled"))
      try {
        return c.json({ available: true as const, ...await workbot().readThread(actor, { turns: c.req.valid("query").turns }) })
      } catch (error) {
        if (error instanceof WorkbotUnavailableError) return c.json(unavailable(error.code))
        throw error
      }
    },
  )

  app.post(
    "/v1/workbot/messages",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "sendWorkbotMessage",
      "x-mcp": false,
      summary: "Send a message to Workbot",
      description: "Adds a message to the member's conversation. Messages sent while Workbot is working are answered in order.",
      responses: {
        202: jsonResponse("Accepted.", z.object({ ok: z.literal(true) })),
        400: jsonResponse("Invalid message.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        409: jsonResponse("Workbot is unavailable.", z.object({ error: z.string() })),
        429: jsonResponse("Too many messages are waiting, or sent too quickly.", z.object({ error: z.enum(["too_many_queued", "rate_limited"]), retryAfter: z.number().optional() })),
      },
    }),
    orgMemberRoute(),
    jsonValidator(sendSchema),
    async (c) => {
      const body = c.req.valid("json")
      if (!body.text && !body.attachments?.length) return c.json({ error: "invalid_request", message: "Send text or a file." }, 400)
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "workbot_not_enabled" }, 409)
      const retryAfter = await checkRateLimit(`workbot:${actor.organizationId}:${actor.memberId}`, MESSAGES_PER_WINDOW, MESSAGE_WINDOW_MS, Date.now())
      if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
      try {
        const sent = await workbot().send(actor, body)
        if (!sent.ok) return c.json({ error: sent.code }, sent.code === "unknown_file" ? 400 : 429)
        return c.json({ ok: true as const }, 202)
      } catch (error) {
        if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
        throw error
      }
    },
  )

  app.post(
    "/v1/workbot/stop",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "stopWorkbot",
      "x-mcp": false,
      summary: "Stop Workbot",
      description: "Stops the answer in progress and any messages waiting behind it.",
      responses: {
        200: jsonResponse("Stopped.", z.object({ stopped: z.boolean() })),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        409: jsonResponse("Workbot is unavailable.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "workbot_not_enabled" }, 409)
      try {
        return c.json(await workbot().stop(actor))
      } catch (error) {
        if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
        throw error
      }
    },
  )

  app.get(
    "/v1/workbot/events",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "streamWorkbotEvents",
      "x-mcp": false,
      summary: "Watch my Workbot conversation",
      description: "Server-sent events while the page is open: `changed` when the conversation changed (read it again), `text` with the reply as it is written, and `working` when Workbot starts a step (`on: computer` for its computer).",
      responses: {
        200: { description: "An event stream.", content: { "text/event-stream": { schema: { type: "string" } } } },
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        409: jsonResponse("Workbot is unavailable.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "workbot_not_enabled" }, 409)
      const upstream = new AbortController()
      const opened = await workbot().openEvents(actor, upstream.signal).catch(() => null)
      if (!opened?.body) return c.json({ error: "workbot_runner_unavailable" }, 409)
      const body = opened.body
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      return streamSSE(c, async (stream) => {
        stream.onAbort(() => upstream.abort())
        const deadline = setTimeout(() => upstream.abort(), EVENTS_MAX_MS)
        const reader = body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ""
        try {
          await stream.writeSSE({ event: "ready", data: "{}" })
          for (;;) {
            const { value, done } = await reader.read()
            if (done || stream.aborted) break
            buffer += value
            let boundary = buffer.indexOf("\n\n")
            while (boundary !== -1) {
              const block = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              boundary = buffer.indexOf("\n\n")
              if (block.startsWith(":")) {
                await stream.write(": keep-alive\n\n")
                continue
              }
              const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
              let parsedJson: unknown = null
              try {
                parsedJson = JSON.parse(data)
              } catch {
                continue
              }
              // Only this person's Workbot turns, under the page's own ids.
              const event = toWorkbotPageEvent(parsedJson)
              if (event) await stream.writeSSE({ data: JSON.stringify(event) })
            }
          }
        } catch {
          // The page reconnects; nothing to report.
        } finally {
          clearTimeout(deadline)
          upstream.abort()
          reader.releaseLock()
        }
      })
    },
  )

  app.post(
    "/v1/workbot/files",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "uploadWorkbotFile",
      "x-mcp": false,
      summary: "Add a file to my Workbot conversation",
      description: "Keeps a file (the raw request body, typed by Content-Type) in the member's Workbot files. Send its id with a message to show it to Workbot.",
      responses: {
        201: jsonResponse("The kept file.", fileSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        409: jsonResponse("Workbot or its files are unavailable.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    queryValidator(uploadQuerySchema),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "workbot_not_enabled" }, 409)
      const query = c.req.valid("query")
      try {
        const file = await workbot().uploadFile(actor, {
          name: query.name,
          mediaType: c.req.header("content-type") ?? "application/octet-stream",
          bytes: await c.req.arrayBuffer(),
          timeZone: query.timeZone,
        })
        return c.json(file, 201)
      } catch (error) {
        if (error instanceof WorkbotFilesUnavailableError) return c.json({ error: "workbot_files_not_configured" }, 409)
        if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
        throw error
      }
    },
  )

  app.get(
    "/v1/workbot/files",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "listWorkbotFiles",
      "x-mcp": false,
      summary: "List my Workbot files",
      description: "Files the member sent to Workbot and files Workbot saved for them, newest first.",
      responses: {
        200: jsonResponse("The files.", z.object({ enabled: z.boolean(), files: z.array(fileSchema) })),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        409: jsonResponse("Workbot is unavailable.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "workbot_not_enabled" }, 409)
      try {
        return c.json(await workbot().listFiles(actor))
      } catch (error) {
        if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
        throw error
      }
    },
  )

  app.get(
    "/v1/workbot/files/:fileId/preview",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "previewWorkbotFile",
      "x-mcp": false,
      summary: "Preview a Workbot file",
      description: "How a slide deck or document looks: the number of page images and their size. 404 when the file has no preview.",
      responses: {
        200: jsonResponse("The preview.", z.object({ pages: z.number(), width: z.number(), height: z.number() })),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("No preview for this file.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    paramValidator(z.object({ fileId: fileIdSchema })),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "not_found" }, 404)
      const manifest = await workbot().readPreview(actor, c.req.valid("param").fileId).catch(() => null)
      return manifest ? c.json(manifest, 200) : c.json({ error: "not_found" }, 404)
    },
  )

  app.get(
    "/v1/workbot/files/:fileId/preview/:page",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "previewWorkbotFilePage",
      "x-mcp": false,
      summary: "Preview page of a Workbot file",
      description: "One page of a slide deck or document as a PNG image.",
      responses: {
        200: { description: "The page image." },
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("No such page.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    paramValidator(z.object({ fileId: fileIdSchema, page: z.coerce.number().int().min(1).max(1_000) })),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "not_found" }, 404)
      const { fileId, page } = c.req.valid("param")
      const upstream = await workbot().downloadPreviewPage(actor, fileId, page).catch(() => null)
      if (!upstream?.body) return c.json({ error: "not_found" }, 404)
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "content-type": "image/png",
          ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length") ?? "" } : {}),
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "private, max-age=3600",
        },
      })
    },
  )

  app.get(
    "/v1/workbot/files/:fileId",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "downloadWorkbotFile",
      "x-mcp": false,
      summary: "Download a Workbot file",
      description: "The file's bytes. Images can be shown inline with `inline=1`; every other type downloads.",
      responses: {
        200: { description: "The file." },
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("No such file.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    paramValidator(z.object({ fileId: fileIdSchema })),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "not_found" }, 404)
      const upstream = await workbot().downloadFile(actor, c.req.valid("param").fileId).catch(() => null)
      if (!upstream?.body) return c.json({ error: "not_found" }, 404)
      const type = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream"
      const encodedName = upstream.headers.get("x-file-name") ?? "file"
      let name = "file"
      try {
        name = decodeURIComponent(encodedName)
      } catch {
        // keep the fallback
      }
      const inline = c.req.query("inline") === "1" && INLINE_TYPES.has(type)
      const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, "_")
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "content-type": inline ? type : type.startsWith("text/") || type === "image/svg+xml" ? "application/octet-stream" : type,
          ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length") ?? "" } : {}),
          "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "private, max-age=3600",
        },
      })
    },
  )

  app.delete(
    "/v1/workbot/files/:fileId",
    describeWorkbotRoute({
      tags: ["Workbot"],
      operationId: "deleteWorkbotFile",
      "x-mcp": false,
      summary: "Delete a Workbot file",
      description: "Deletes the file and its stored bytes. Messages that sent it keep its name.",
      responses: {
        204: { description: "Deleted." },
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("No such file.", z.object({ error: z.string() })),
      },
    }),
    orgMemberRoute(),
    paramValidator(z.object({ fileId: fileIdSchema })),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "forbidden" }, 403)
      if (!workbotEnabled(actor.organizationMetadata)) return c.json({ error: "not_found" }, 404)
      const deleted = await workbot().deleteFile(actor, c.req.valid("param").fileId).catch(() => false)
      return deleted ? c.body(null, 204) : c.json({ error: "not_found" }, 404)
    },
  )
}
