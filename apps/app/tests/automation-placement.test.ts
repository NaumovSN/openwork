import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import type {
  AutomationCloudTarget,
  AutomationDesktopTarget,
  AutomationExecutionTarget,
  AutomationExecutionTargetList,
  CreateAutomation,
} from "@openwork/types/automations"

import {
  automationCloudRunAvailable, automationCloudRuntime,
  automationPlacementChoices,
  resolveAutomationPlacement,
} from "../src/react-app/domains/automations/automation-placement"
import type { AutomationModelOption } from "../src/react-app/domains/automations/automation-model-options"
import { organizationRunnerId } from "../src/react-app/domains/automations/automation-runner-identity"

// Base UI detects DOM support when its module loads.
GlobalRegistrator.register({ url: "http://localhost" })
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
afterAll(async () => { await GlobalRegistrator.unregister() })
const { createRoot } = await import("react-dom/client")
const auth = await import("../src/react-app/domains/cloud/den-auth-provider")
const desktopPolicy = await import("../src/react-app/domains/cloud/desktop-config-provider")
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform")
let restore = () => {}
beforeEach(() => {
  const policy = spyOn(desktopPolicy, "useCheckDesktopRestriction").mockReturnValue(() => false)
  const session = spyOn(auth, "useDenAuth").mockReturnValue({
    status: "signed_in", user: null, verifiedIdentity: { principalId: "fixture", organizationId: "fixture" },
    isSignedIn: true, error: null, refresh: async () => undefined,
  })
  restore = () => { policy.mockRestore(); session.mockRestore() }
})
afterEach(() => restore())

function targets(items: AutomationExecutionTargetList["items"]): AutomationExecutionTargetList {
  return { items }
}
const desktop: AutomationDesktopTarget = { kind: "desktop", id: "rnr_fixture", platform: "darwin", appVersion: "0.0.0", lastSeenAt: 1, connected: true }
function cloud(available: boolean): AutomationCloudTarget {
  return available ? { kind: "cloud", available: true, runtime: "headless" } : { kind: "cloud", available: false, runtime: null }
}

describe("Automation placement choices", () => {
  test("a Den too old to answer offers no choice, so the fixed placement stands", () => {
    expect(automationPlacementChoices({ targets: null, desktopRuntime: true })).toEqual([])
    expect(automationPlacementChoices({ targets: undefined, desktopRuntime: false })).toEqual([])
    expect(resolveAutomationPlacement("desktop", [])).toBe("desktop")
    expect(resolveAutomationPlacement("cloud", [])).toBe("cloud")
  })

  test("the desktop build always counts itself; a browser counts the desktops Den has seen", () => {
    expect(automationPlacementChoices({ targets: targets([cloud(false)]), desktopRuntime: true })).toEqual(["desktop"])
    expect(automationPlacementChoices({ targets: targets([cloud(true)]), desktopRuntime: false })).toEqual(["cloud"])
    expect(automationPlacementChoices({ targets: targets([desktop, cloud(true)]), desktopRuntime: false })).toEqual(["desktop", "cloud"])
  })

  test("today's placement stays the default unless only the other target exists", () => {
    expect(resolveAutomationPlacement("desktop", ["desktop", "cloud"])).toBe("desktop")
    expect(resolveAutomationPlacement("cloud", ["desktop", "cloud"])).toBe("cloud")
    expect(resolveAutomationPlacement("cloud", ["desktop"])).toBe("desktop")
  })

  test("a cloud run reaches connected accounts only on the headless runtime, files too on a cloud computer", () => {
    expect(automationCloudRuntime(targets([desktop, { kind: "cloud", available: true, runtime: "headless" }]))).toBe("headless")
    expect(automationCloudRuntime(targets([desktop, { kind: "cloud", available: true, runtime: "web" }]))).toBe("web")
    expect(automationCloudRuntime(targets([desktop, cloud(false)]))).toBeNull()
    expect(automationCloudRuntime(null)).toBeNull()
  })

  test("running once in the cloud is offered only when Cloud can run it now", () => {
    expect(automationCloudRunAvailable(targets([desktop, cloud(true)]))).toBe(true)
    expect(automationCloudRunAvailable(targets([desktop, cloud(false)]))).toBe(false)
    expect(automationCloudRunAvailable(null)).toBe(false)
  })

  test("an older Den gets a stable per-organization runner id instead of a reset install id", () => {
    expect(organizationRunnerId("install-1", "org_a")).toBe(organizationRunnerId("install-1", "org_a"))
    expect(organizationRunnerId("install-1", "org_a")).not.toBe(organizationRunnerId("install-1", "org_b"))
    expect(organizationRunnerId("install-1", "org_a")).not.toBe("install-1")
  })
})

describe("Automation editor: what it can use", () => {
  const starter: AutomationModelOption = { providerId: "opencode", modelId: "big-pickle", providerName: "OpenCode Zen", modelName: "Big Pickle", accessKind: "free" }
  const team: AutomationModelOption = { providerId: "lpr_fixture", modelId: "team-model", providerName: "Team provider", modelName: "Team model", accessKind: "authorized_custom" }

  async function renderEditor(
    placementChoices: readonly AutomationExecutionTarget[],
    context: { cloudRuntime?: "headless" | "web" | null; onThisComputer?: boolean } = { cloudRuntime: "headless", onThisComputer: true },
  ) {
    const { AutomationEditor } = await import("../src/react-app/domains/automations/automation-editor")
    const saved: Array<{ input: CreateAutomation; placement: AutomationExecutionTarget }> = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
      createElement(AutomationEditor, {
        placement: "desktop", placementChoices, modelOptions: [starter, team],
        cloudRuntime: context.cloudRuntime, onThisComputer: context.onThisComputer,
        connectedAccounts: [{ id: "c1", name: "Slack", iconUrl: null }, { id: "c2", name: "Notion", iconUrl: null }],
        modelOptionsByPlacement: { desktop: [starter, team], cloud: [team] },
        busy: false, submitLabel: "Create and activate", onCancel: () => undefined,
        onSave: (input, placement) => { saved.push({ input, placement }) },
      }) })))
    return {
      saved,
      async type(selector: string, value: string) {
        const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
        if (!field) throw new Error(`Missing field ${selector}`)
        const prototype = field instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        await act(async () => {
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value)
          field.dispatchEvent(new Event("input", { bubbles: true }))
        })
      },
      async choose(index: number) {
        const radio = document.querySelectorAll<HTMLElement>('[data-automation-runs-on] [role="radio"]')[index]
        if (!radio) throw new Error(`Missing choice ${index}`)
        await act(async () => radio.click())
      },
      async click(label: string) {
        const control = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)
        if (!control) throw new Error(`Missing button ${label}`)
        await act(async () => control.click())
      },
      async unmount() {
        await act(async () => root.unmount())
        host.remove()
      },
    }
  }

  test("only one target means no choice", async () => {
    const editor = await renderEditor(["desktop"])
    try {
      expect(document.querySelector("[data-automation-runs-on]")).toBeNull()
      expect(document.querySelector("[data-automation-placement]")?.getAttribute("data-automation-placement")).toBe("desktop")
    } finally {
      await editor.unmount()
    }
  })

  test("the choices say what it can use, with the connected accounts it would use", async () => {
    const editor = await renderEditor(["desktop", "cloud"])
    try {
      const choices = document.querySelector("[data-automation-runs-on]")?.textContent ?? ""
      expect(choices).toContain("Your connected accounts and files on this computer")
      expect(choices).toContain("Only your connected accounts")
      expect(document.querySelector("[data-automation-connected-accounts]")?.getAttribute("aria-label")).toBe("Slack, Notion")
    } finally {
      await editor.unmount()
    }
    const web = await renderEditor(["desktop", "cloud"], { cloudRuntime: "web", onThisComputer: false })
    try {
      const choices = document.querySelector("[data-automation-runs-on]")?.textContent ?? ""
      expect(choices).toContain("Your connected accounts and files on your computer")
      expect(choices).toContain("Your connected accounts and files on your cloud computer")
      expect(document.querySelector("[data-automation-connected-accounts]")).toBeNull()
    } finally {
      await web.unmount()
    }
  })

  test("choosing connected accounts only keeps what was typed, leaves the desktop-only starter model, and saves with the choice", async () => {
    const editor = await renderEditor(["desktop", "cloud"])
    try {
      await editor.type("#automation-name", "Morning brief")
      await editor.type("#automation-instructions", "Summarize what changed overnight.")
      expect(document.querySelector("#automation-model")?.textContent).toContain("Big Pickle")
      await editor.choose(1)
      expect(document.querySelector("[data-automation-runs-on]")?.getAttribute("data-automation-runs-on")).toBe("cloud")
      expect(document.querySelector("[data-automation-placement]")?.textContent).toBe("Runs in the cloud, even when your computer is off.")
      expect(document.querySelector("[data-automation-placement]")?.getAttribute("data-automation-placement")).toBe("cloud")
      expect(document.querySelector("#automation-model")?.textContent).toContain("Team model")
      expect(document.querySelector<HTMLInputElement>("#automation-name")?.value).toBe("Morning brief")
      await act(async () => document.querySelector<HTMLButtonElement>('[data-automation-editor] button[type="submit"]')?.click())
      expect(editor.saved).toHaveLength(1)
      expect(editor.saved[0]?.placement).toBe("cloud")
      expect(editor.saved[0]?.input).toMatchObject({
        name: "Morning brief",
        instructions: "Summarize what changed overnight.",
        model: { providerId: "lpr_fixture", modelId: "team-model", variant: null },
      })
    } finally {
      await editor.unmount()
    }
  })
})
