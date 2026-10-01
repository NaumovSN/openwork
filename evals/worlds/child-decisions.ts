import { addInitScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { delegatedQuestionHandoff } from "./chat.ts";

export async function childDecisionsWeb(seed: Seed) {
  const world = await delegatedQuestionHandoff(seed, "web");
  // Inject a transport fault before the next page load. The engine still owns
  // real pending forms; only their live notification is lost. Snapshot reads,
  // tool progress, session ownership and answers pass through unchanged.
  await addInitScript(world.app.client, () => {
    Reflect.set(window, "__childDecisionNotificationsDropped", 0);
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      const filtered = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            if (/"type"\s*:\s*"(?:form\.created|question\.asked)"/.test(frame)) {
              Reflect.set(window, "__childDecisionNotificationsDropped", Number(Reflect.get(window, "__childDecisionNotificationsDropped")) + 1);
            } else controller.enqueue(encoder.encode(frame + "\n\n"));
          }
        },
        flush(controller) { if (buffer) controller.enqueue(encoder.encode(buffer)); },
      }));
      return new Response(filtered, { status: response.status, headers: response.headers });
    };
  });
  return world;
}
