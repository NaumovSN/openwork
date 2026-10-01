import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
import type {
  AutomationCloudTarget,
  AutomationDesktopTarget,
  AutomationExecutionTarget,
  AutomationExecutionTargetList,
  CreateAutomation,
} from "@openwork/types/automations"

import {
  automationCloudOptions, automationCloudRunAvailable,
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
function cloud(available: boolean, cloudComputer = false): AutomationCloudTarget {
  return available ? { kind: "cloud", available: true, runtime: "headless", cloudComputer } : { kind: "cloud", available: false, runtime: null, cloudComputer: false }
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

  test("the cloud offers a computer's files, only connected accounts, or both", () => {
    expect(automationCloudOptions(targets([desktop, cloud(true)]))).toEqual({ cloudComputer: false, accountsOnly: true })
    expect(automationCloudOptions(targets([desktop, cloud(true, true)]))).toEqual({ cloudComputer: true, accountsOnly: true })
    expect(automationCloudOptions(targets([desktop, { kind: "cloud", available: true, runtime: "web", cloudComputer: true }]))).toEqual({ cloudComputer: true, accountsOnly: false })
    expect(automationCloudOptions(targets([desktop, cloud(false)]))).toEqual({ cloudComputer: false, accountsOnly: false })
    expect(automationCloudOptions(null)).toBeUndefined()
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
    context: { cloudOptions?: { cloudComputer: boolean; accountsOnly: boolean }; onThisComputer?: boolean } = { cloudOptions: { cloudComputer: false, accountsOnly: true }, onThisComputer: true },
  ) {
    const { AutomationEditor } = await import("../src/react-app/domains/automations/automation-editor")
    const saved: Array<{ input: CreateAutomation; placement: AutomationExecutionTarget }> = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
      createElement(AutomationEditor, {
        placement: "desktop", placementChoices, modelOptions: [starter, team],
        cloudOptions: context.cloudOptions, onThisComputer: context.onThisComputer,
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
      expect(choices).toContain("Connected accounts and files on this computer")
      expect(choices).toContain("Only connected accounts")
      // Both choices show the accounts; only the one with files adds the computer.
      const [withFiles, accountsOnly] = [...document.querySelectorAll("[data-automation-connected-accounts]")]
      expect(withFiles?.getAttribute("aria-label")).toBe("Files on your computer, plus Slack, Notion")
      expect(withFiles?.querySelector('[data-automation-files="computer"]')).not.toBeNull()
      expect(accountsOnly?.getAttribute("aria-label")).toBe("Slack, Notion")
      expect(accountsOnly?.querySelector("[data-automation-files]")).toBeNull()
    } finally {
      await editor.unmount()
    }
    const web = await renderEditor(["desktop", "cloud"], { cloudOptions: { cloudComputer: true, accountsOnly: false }, onThisComputer: false })
    try {
      const choices = document.querySelector("[data-automation-runs-on]")?.textContent ?? ""
      expect(choices).toContain("Connected accounts and files on your computer")
      expect(choices).toContain("Connected accounts and files on your cloud computer")
      expect(choices).not.toContain("Only connected accounts")
      expect(document.querySelectorAll('[data-automation-files="computer"]')).toHaveLength(1)
      expect(document.querySelectorAll('[data-automation-files="cloud-computer"]')).toHaveLength(1)
    } finally {
      await web.unmount()
    }
  })

  test("with a cloud computer and the headless runtime, all three choices are offered", async () => {
    const editor = await renderEditor(["desktop", "cloud"], { cloudOptions: { cloudComputer: true, accountsOnly: true }, onThisComputer: true })
    try {
      const labels = [...document.querySelectorAll("[data-automation-runs-on] label")].map((row) => row.querySelector(".flex-1")?.textContent)
      expect(labels).toEqual([
        "Connected accounts and files on this computer",
        "Connected accounts and files on your cloud computer",
        "Only connected accounts",
      ])
      // A cloud computer run keeps a chosen model.
      await editor.choose(1)
      expect(document.querySelector("[data-automation-can-use]")?.getAttribute("data-automation-can-use")).toBe("cloud-computer")
      expect(document.querySelector("#automation-model")?.textContent).toContain("Team model")
      expect(document.querySelector("[data-automation-placement]")?.textContent).toBe("Runs on your cloud computer, even when your desktop is offline.")
    } finally {
      await editor.unmount()
    }
  })

  test("choosing only connected accounts keeps what was typed and runs on the cloud's one model", async () => {
    const editor = await renderEditor(["desktop", "cloud"])
    try {
      await editor.type("#automation-name", "Morning brief")
      await editor.type("#automation-instructions", "Summarize what changed overnight.")
      expect(document.querySelector("#automation-model")?.textContent).toContain("Big Pickle")
      await editor.choose(1)
      expect(document.querySelector("[data-automation-runs-on]")?.getAttribute("data-automation-runs-on")).toBe("cloud")
      expect(document.querySelector("[data-automation-placement]")?.textContent).toBe("Runs in the cloud, even when your computer is off.")
      expect(document.querySelector("[data-automation-placement]")?.getAttribute("data-automation-placement")).toBe("cloud")
      // Nothing to pick: it runs on the organization's cloud model.
      expect(document.querySelector("#automation-model")).toBeNull()
      expect(document.querySelector<HTMLInputElement>("#automation-name")?.value).toBe("Morning brief")
      await act(async () => document.querySelector<HTMLButtonElement>('[data-automation-editor] button[type="submit"]')?.click())
      expect(editor.saved).toHaveLength(1)
      expect(editor.saved[0]?.placement).toBe("cloud")
      expect(editor.saved[0]?.input).toMatchObject({
        name: "Morning brief",
        instructions: "Summarize what changed overnight.",
        model: { providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId, variant: null },
      })
      // Back to this computer: a model it can use again.
      await editor.choose(0)
      expect(document.querySelector("#automation-model")?.textContent).toContain("Big Pickle")
    } finally {
      await editor.unmount()
    }
  })
})
