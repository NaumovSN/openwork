import { beforeAll, describe, expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  desktopHandoffMessage,
  excerpt,
  FINISHED_TEXT_LIMIT,
  slackSafeText,
} from "../src/slack-assistant/desktop-handoff-messages.js"
import { DEN_MCP_HEADLESS_RUN_CLIENT_ID, headlessRunTokenId } from "../src/mcp/headless-run-token.js"
import type { RemoteSessionExecuteDeps, RemoteSessionToolResult } from "../src/mcp/remote-session-capabilities.js"
import type { RemoteSessionCommand, RemoteSessionCommandStore } from "../src/remote-sessions/commands.js"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"

let nextHandoffStep: (typeof import("../src/slack-assistant/desktop-handoff.js"))["nextHandoffStep"]
let executeRemoteSessionCapability: (typeof import("../src/mcp/remote-session-capabilities.js"))["executeRemoteSessionCapability"]
beforeAll(async () => {
  nextHandoffStep = (await import("../src/slack-assistant/desktop-handoff.js")).nextHandoffStep
  executeRemoteSessionCapability = (await import("../src/mcp/remote-session-capabilities.js")).executeRemoteSessionCapability
})

const NOW = Date.UTC(2026, 9, 1, 12)
const ORGANIZATION_ID = createDenTypeId("organization")
const USER_ID = createDenTypeId("user")
const MEMBER_ID = createDenTypeId("member")
const COMMAND_ID = createDenTypeId("remoteSessionCommand")

function command(overrides: Partial<RemoteSessionCommand> = {}): RemoteSessionCommand {
  return {
    id: COMMAND_ID,
    organizationId: ORGANIZATION_ID,
    ownerMemberId: MEMBER_ID,
    createdByUserId: USER_ID,
    status: "delivered",
    title: "Remote session",
    prompt: "Do the thing",
    model: null,
    idempotencyKey: null,
    expiresAt: NOW + 600_000,
    claimedByRunnerId: "runner",
    claimedAt: NOW,
    sessionId: "ses_1",
    workspaceId: "ws_1",
    resultSummary: null,
    error: null,
    session: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function progress(overrides: Partial<NonNullable<RemoteSessionCommand["session"]>>): RemoteSessionCommand["session"] {
  return {
    status: "running",
    waitingFor: null,
    engine: "v2",
    model: null,
    finalText: null,
    lastError: null,
    messageCount: 2,
    observedAt: NOW,
    ...overrides,
  }
}

const fresh = { waitingPosted: false, createdAt: new Date(NOW) }

describe("thread messages", () => {
  test("model text cannot mention, broadcast, or hide a link", () => {
    const text = slackSafeText("Hi <@U999> and <!channel>, see <https://evil.example|docs> & tell @here @Everyone")
    expect(text).not.toContain("<")
    expect(text).not.toContain(">")
    expect(text).toContain("&lt;@U999&gt;")
    expect(text).toContain("&lt;!channel&gt;")
    expect(text).toContain("&lt;https://evil.example|docs&gt;")
    expect(text).toContain("&amp; tell")
    expect(text).not.toMatch(/@(here|everyone)\b/i)
  })

  test("a finished task mentions the person and quotes at most ~600 characters of the answer", () => {
    const long = `${"word ".repeat(300)}end`
    const message = desktopHandoffMessage("U123ABC", { kind: "finished", finalText: long })
    expect(message.startsWith("<@U123ABC> Your desktop finished: word")).toBe(true)
    expect(message.endsWith("…")).toBe(true)
    expect(message.length).toBeLessThan(FINISHED_TEXT_LIMIT + 60)
    expect(desktopHandoffMessage("U123ABC", { kind: "finished", finalText: "  " })).toBe("<@U123ABC> Your desktop finished.")
  })

  test("a cut never leaves a code block open and only real Slack user ids are mentioned", () => {
    const cut = excerpt(`intro\n\`\`\`\n${"x ".repeat(400)}\n\`\`\``, 100)
    expect((cut.match(/```/g) ?? []).length % 2).toBe(0)
    expect(desktopHandoffMessage("<!channel>", { kind: "expired" }).startsWith("Your desktop")).toBe(true)
  })

  test("failures, waiting, expiry and delivery failures read plainly", () => {
    expect(desktopHandoffMessage("U1A", { kind: "failed", message: "The provider rejected the key." })).toBe(
      "<@U1A> The task on your desktop failed: The provider rejected the key. It's still open in OpenWork on that computer.",
    )
    expect(desktopHandoffMessage("U1A", { kind: "waiting", waitingFor: "permission" })).toBe(
      "<@U1A> Your desktop is waiting for you to approve something in OpenWork.",
    )
    expect(desktopHandoffMessage("U1A", { kind: "waiting", waitingFor: "question" })).toContain("answer a question")
    expect(desktopHandoffMessage("U1A", { kind: "expired" })).toContain("didn't pick up the task in time")
    expect(desktopHandoffMessage("U1A", { kind: "undeliverable", message: "No reply <@U2>." })).toBe(
      "<@U1A> The task couldn't start on your desktop: No reply &lt;@U2&gt;.",
    )
  })
})

describe("what the thread hears next", () => {
  test("terminal outcomes post once each", () => {
    expect(nextHandoffStep(command({ session: progress({ status: "idle", finalText: "Done" }) }), fresh, NOW)).toEqual({
      action: "post",
      notice: { kind: "finished", finalText: "Done" },
      outcome: "finished",
    })
    expect(
      nextHandoffStep(
        command({ session: progress({ status: "error", lastError: { code: "x", message: "Broke" } }) }),
        fresh,
        NOW,
      ),
    ).toMatchObject({ action: "post", outcome: "failed", notice: { kind: "failed", message: "Broke" } })
    expect(
      nextHandoffStep(command({ status: "failed", error: { code: "no_reply", message: "No reply" } }), fresh, NOW),
    ).toMatchObject({ action: "post", outcome: "undeliverable", notice: { message: "No reply" } })
    expect(nextHandoffStep(command({ status: "expired" }), fresh, NOW)).toMatchObject({ outcome: "expired" })
    expect(nextHandoffStep(command({ status: "pending", expiresAt: NOW - 1 }), fresh, NOW)).toMatchObject({
      outcome: "expired",
    })
  })

  test("waiting posts once per episode and resets when the session moves on", () => {
    const waiting = command({ session: progress({ status: "waiting", waitingFor: "permission" }) })
    expect(nextHandoffStep(waiting, fresh, NOW)).toMatchObject({ action: "post", outcome: null })
    expect(nextHandoffStep(waiting, { ...fresh, waitingPosted: true }, NOW)).toEqual({ action: "wait" })
    expect(nextHandoffStep(command({ session: progress({}) }), { ...fresh, waitingPosted: true }, NOW)).toEqual({
      action: "reset_waiting",
    })
  })

  test("pending, running, unreported and long-silent work", () => {
    expect(nextHandoffStep(command({ status: "pending" }), fresh, NOW)).toEqual({ action: "wait" })
    expect(nextHandoffStep(command({ status: "claimed" }), fresh, NOW)).toEqual({ action: "wait" })
    expect(nextHandoffStep(command({ session: null }), fresh, NOW)).toEqual({ action: "wait" })
    expect(nextHandoffStep(command(), { ...fresh, createdAt: new Date(NOW - 8 * 86_400_000) }, NOW)).toEqual({
      action: "close",
      outcome: "abandoned",
    })
    expect(nextHandoffStep(null, fresh, NOW)).toEqual({ action: "close", outcome: "abandoned" })
  })
})

describe("linking a desktop command to its Slack run", () => {
  test("only Den's headless-run tokens carry a run token id", () => {
    expect(headlessRunTokenId({ client_id: DEN_MCP_HEADLESS_RUN_CLIENT_ID, openwork_run_token_id: "oat_1" })).toBe("oat_1")
    expect(headlessRunTokenId({ client_id: "other-client", openwork_run_token_id: "oat_1" })).toBeNull()
    expect(headlessRunTokenId({ client_id: DEN_MCP_HEADLESS_RUN_CLIENT_ID })).toBeNull()
  })

  function payload(result: RemoteSessionToolResult): Record<string, unknown> {
    return result.structuredContent ?? {}
  }

  function deps(link: RemoteSessionExecuteDeps["linkDesktopCommand"]): RemoteSessionExecuteDeps {
    const store: RemoteSessionCommandStore = {
      enqueue: async (input) => command({ status: "pending", prompt: input.prompt ?? null }),
      claim: async () => null,
      complete: async () => null,
      report: async () => "not_found",
      get: async () => null,
      listPendingForRunner: async () => [],
    }
    return {
      getOpenWorkWebAccess: async () => ({ hasAccess: true }),
      resolveRuntime: async () => {
        throw new Error("not used")
      },
      createClient: () => {
        throw new Error("not used")
      },
      commandStore: store,
      desktopPresence: async () => ({ connected: true, ownerMemberId: MEMBER_ID }),
      linkDesktopCommand: link,
    }
  }

  const create = (body: Record<string, unknown>, headlessRunTokenId?: string) => ({
    action: "create" as const,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    hasWriteScope: true,
    body: { target: "desktop", ...body },
    headlessRunTokenId,
  })

  test("a Slack run's desktop handoff is linked and the result says it will post in the thread", async () => {
    const calls: unknown[] = []
    const result = await executeRemoteSessionCapability(
      create({ prompt: "Clean up the notes" }, "oat_run"),
      deps(async (input) => {
        calls.push(input)
        return true
      }),
    )
    expect(calls).toEqual([{ commandId: COMMAND_ID, organizationId: ORGANIZATION_ID, userId: USER_ID, runTokenId: "oat_run" }])
    expect(payload(result)).toMatchObject({ state: "queued", commandId: COMMAND_ID, resultPostedInThread: true })
  })

  test("no run token, no prompt, or a failing link: the command still queues and promises nothing", async () => {
    let called = 0
    const link = async () => {
      called += 1
      return true
    }
    expect(payload(await executeRemoteSessionCapability(create({ prompt: "x" }), deps(link)))).not.toHaveProperty(
      "resultPostedInThread",
    )
    expect(payload(await executeRemoteSessionCapability(create({}, "oat_run"), deps(link)))).not.toHaveProperty(
      "resultPostedInThread",
    )
    expect(called).toBe(0)
    const failing = await executeRemoteSessionCapability(
      create({ prompt: "x" }, "oat_run"),
      deps(async () => {
        throw new Error("db down")
      }),
    )
    expect(failing.isError).toBeUndefined()
    expect(payload(failing)).toMatchObject({ state: "queued" })
    expect(payload(failing)).not.toHaveProperty("resultPostedInThread")
  })

  test("the headless runner mints each run's token with that run's turn id", async () => {
    const { headlessRemoteCall } = await import("../src/slack-assistant/headless.js")
    const minted: unknown[] = []
    await headlessRemoteCall(
      { userId: USER_ID, organizationId: ORGANIZATION_ID },
      "send",
      { sessionId: "ses_1", messageId: "msg_abc", prompt: "hi" },
      {
        config: { url: "http://runner", token: "t".repeat(32) },
        fetch: async () => new Response("{}", { status: 202 }),
        mintToken: async (input) => {
          minted.push(input)
          return { token: "ow_mcp_at_x" }
        },
      },
    )
    expect(minted).toEqual([{ userId: USER_ID, organizationId: ORGANIZATION_ID, messageId: "msg_abc" }])
  })
})
