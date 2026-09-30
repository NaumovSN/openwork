import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { formatElapsedSeconds } from "@/lib/tool-call-duration";
import { cn } from "@/lib/utils";
import { useWorkbenchDisclosure } from "@/react-app/domains/session/chat/workbench-ui-state";

/** One shell survives tool boundaries, waiting, and the terminal fold. */
export function SteadyActivity({ active, waiting, label, summary, count, elapsed, models, modelsResolved, children, disclosureKey }: {
  active: boolean; waiting: boolean; label: string; summary: string; count: number;
  elapsed: number; models?: string; modelsResolved?: boolean; children: ReactNode; disclosureKey?: string;
}) {
  const [open, setOpen] = useWorkbenchDisclosure(disclosureKey);
  const showLiveShimmer = !open || Children.count(children) === 0;
  const [reading, setReading] = useState(false);
  const wasActive = useRef(active);
  const terminalFoldPending = useRef(false);
  const [displayed, setDisplayed] = useState(label);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const previous = useRef(label);
  const shownAt = useRef(0);
  const latest = useRef(label);
  latest.current = label;
  useEffect(() => {
    if (!active || waiting) { setDisplayed(label); return; }
    const delay = Math.max(0, 600 - (Date.now() - shownAt.current));
    const timer = window.setTimeout(() => { setDisplayed(latest.current); shownAt.current = Date.now(); }, delay);
    return () => window.clearTimeout(timer);
  }, [label, active, waiting]);
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = displayed;
    if (!active || waiting || old === displayed) { setOutgoing(null); return; }
    setOutgoing(old);
    const timer = window.setTimeout(() => setOutgoing(null), 150);
    return () => window.clearTimeout(timer);
  }, [displayed, active, waiting]);
  useEffect(() => {
    if (wasActive.current && !active) terminalFoldPending.current = true;
    wasActive.current = active;
    if (active) terminalFoldPending.current = false;
    else if (terminalFoldPending.current && !reading) {
      terminalFoldPending.current = false;
      setOpen(false);
    }
  }, [active, reading]);
  const rail = useRef<HTMLDivElement>(null);
  const tallest = useRef(0);
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element || !open || !active || typeof ResizeObserver === "undefined") return;
    const hold = () => {
      tallest.current = Math.max(tallest.current, element.scrollHeight);
      element.style.minHeight = `${tallest.current}px`;
    };
    hold();
    const observer = new ResizeObserver(hold);
    for (const child of element.children) observer.observe(child);
    const mutations = new MutationObserver(hold);
    mutations.observe(element, { childList: true, subtree: true });
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [open, active, children]);
  return <div data-steady-activity data-live-steps={active ? "" : undefined}
    onPointerEnter={() => setReading(true)} onPointerLeave={() => setReading(false)}
    onFocusCapture={() => setReading(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setReading(false); }}>
    <div className="mx-auto w-full max-w-3xl px-2 md:px-10">
      <button type="button" onClick={() => { tallest.current = 0; terminalFoldPending.current = false; setOpen(!open); }}
        className="group flex h-7 w-full items-center gap-1 text-start text-sm text-muted-foreground hover:text-foreground"
        data-testid={!active ? "completed-work-rail" : undefined} aria-expanded={open} aria-label={`${active ? "Earlier steps" : summary}. ${open ? "Hide" : "Show"} steps`}>
        <ChevronRight className={cn("size-3.5 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
        <span>{active ? `${Math.max(0, count - 1)} earlier steps` : summary}</span>
        <span data-testid={modelsResolved ? "reply-model" : undefined} className="ms-2 text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-60 group-focus-visible:opacity-60 motion-reduce:transition-none">{models}</span>
      </button>
      {active ? <>
        <div data-current-step className="relative flex h-8 items-center text-sm text-muted-foreground">
          {outgoing ? <span aria-hidden className="absolute inset-y-0 flex items-center animate-out fade-out duration-150 motion-reduce:hidden">{outgoing}</span> : null}
          <span key={displayed} className={cn("animate-in fade-in duration-150 motion-reduce:animate-none", showLiveShimmer && !waiting && !displayed.startsWith("Starting") && "ow-text-shimmer")}>{displayed}</span>
        </div>
        <div role="status" aria-live="off" data-loading-message={waiting ? "waiting" : "working"} data-working-line className="flex h-6 items-center text-xs tabular-nums text-muted-foreground/70">
          {waiting ? "Waiting for your action" : "Working"} {formatElapsedSeconds(elapsed)}
        </div>
      </> : null}
    </div>
    <div ref={rail} hidden={!open} data-steps-rail className={cn("flex-col gap-2", open ? "flex" : "hidden")} style={!active || !open ? { minHeight: undefined } : undefined}>
      {children}
    </div>
  </div>;
}
