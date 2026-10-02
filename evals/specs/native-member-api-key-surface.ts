import { browserScript, evalIn, eventually, screenshot } from "@openwork/testkit";
import type { App } from "@openwork/testkit";

type SavedReceipt = { httpStatus: number; stored: boolean; organizationId: string; memberId: string; connectionId: string };
declare global {
  interface Window {
    __OPENWORK_MEMBER_API_KEY_PROOF__?: { subscribe(callback: (receipt: SavedReceipt) => void): () => void };
    __nativeMemberSaveObservation?: { receipt: { status: number; body: { ok: boolean } } | null; dispose: () => void };
  }
}

export function createNativeMemberKeySurface(input: {
  surface: App; entry: "library" | "chat"; connectionName: string;
  organizationId: string; memberId: string; connectionId: string;
}) {
  const { surface, connectionName, entry } = input;
  return {
    async openDialog() {
      await eventually(() => evalIn(surface, browserScript((name, origin) => {
        const visible = (node: Element) => node.getClientRects().length > 0;
        let scope: Element | null = null;
        if (origin === "chat") {
          const cards = [...document.querySelectorAll('[data-testid="desktop-connection-card"]')]
            .filter(node => visible(node) && node.getAttribute("aria-label") === `${name} connection`);
          if (cards.length !== 1) return false;
          scope = cards[0];
        } else {
          const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
            .filter(node => visible(node) && node.textContent?.trim() === name);
          if (headings.length !== 1) return false;
          scope = headings[0].parentElement;
          while (scope && scope !== document.body) {
            if ([...scope.querySelectorAll("button")].some(button => visible(button) && ["Add key", "Replace key"].includes(button.textContent?.trim() ?? ""))) break;
            scope = scope.parentElement;
          }
          if (scope === document.body) return false;
        }
        const buttons = [...(scope?.querySelectorAll("button") ?? [])].filter(button => visible(button) && !button.disabled
          && ["Add key", "Replace key"].includes(button.textContent?.trim() ?? ""));
        if (buttons.length !== 1) return false;
        buttons[0].click();
        return true;
      }, [connectionName, entry])), { within: 20_000, label: "connection-scoped member key action", until: Boolean });
    },
    readInputState() {
      return evalIn(surface, () => {
        const field = document.querySelector('[data-testid="member-api-key-input"]');
        if (!(field instanceof HTMLInputElement) || field.disabled) throw new Error("Member key input unavailable");
        return { type: field.type, empty: field.value.length === 0 };
      });
    },
    async captureSafe(stage: "empty-dialog" | "key-saved") {
      const empty = await evalIn(surface, () => [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].every(field => field.value === ""));
      if (!empty) throw new Error("Member key screenshot refused while input contains a value");
      await screenshot(surface, { caption: `${connectionName}: ${stage}` });
    },
    async armSave() {
      await evalIn(surface, browserScript((expected) => {
        const proof = window.__OPENWORK_MEMBER_API_KEY_PROOF__;
        if (!proof) throw new Error("Owned test observer unavailable");
        window.__nativeMemberSaveObservation?.dispose();
        const observation: NonNullable<Window["__nativeMemberSaveObservation"]> = { receipt: null, dispose: () => undefined };
        observation.dispose = proof.subscribe(receipt => {
          if (receipt.httpStatus === 200 && receipt.stored === true && receipt.organizationId === expected.organizationId
            && receipt.memberId === expected.memberId && receipt.connectionId === expected.connectionId) {
            observation.receipt = { status: 200, body: { ok: true } };
          }
        });
        window.__nativeMemberSaveObservation = observation;
      }, [{ organizationId: input.organizationId, memberId: input.memberId, connectionId: input.connectionId }]));
      return {
        result: (within: number) => eventually(() => evalIn(surface, () => window.__nativeMemberSaveObservation?.receipt ?? null),
          { within, label: "same-member acknowledged save", until: receipt => receipt?.status === 200 && receipt.body.ok }),
        dispose: () => evalIn(surface, () => { window.__nativeMemberSaveObservation?.dispose(); delete window.__nativeMemberSaveObservation; }),
      };
    },
    secretAbsentFromVisibleUi(secret: string) {
      return evalIn(surface, browserScript(candidate => !document.body.innerText.includes(candidate)
        && [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].every(field => !field.value.includes(candidate)), [secret]));
    },
  };
}
