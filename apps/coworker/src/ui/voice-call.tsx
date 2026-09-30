import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type MouseEvent } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { callDuration } from "@/lib/call";
import { coworkerCall, openCallSettings } from "@/lib/realtime-call";
import { CoworkerAvatar, avatarFill, expressCoworker } from "@/ui/coworker-avatar";
import { useActivityPopover } from "@/ui/work-popover";
import { ChatReply } from "@/ui/chat-reply";
import { IconButton, ToolIcon, WorkersIcon } from "@/ui/kit";
import { onSuperAction, useSuperKey, superKeyShortcut } from "@/ui/use-super-key";
import "./call-avatar.css";
export function useCallState() { return useSyncExternalStore(coworkerCall.subscribe, coworkerCall.snapshot); }
export function PhoneIcon({ end = false }: { end?: boolean }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`size-5 ${end ? "rotate-[135deg]" : ""}`}><path d="M7 3 4 4c-3 3 1 9 4 12s9 7 12 4l1-3-5-3-2 2c-3-1-5-3-6-6l2-2-3-5Z" /></svg>; }
export function CallButton({ person, threadId, prepare, active = true }: { person: CoworkerSummary; threadId?: string; prepare?: () => Promise<string>; active?: boolean }) {
  const state = useCallState(); const superKey = useSuperKey(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const action = useRef<() => void>(() => {});
  const [keySet, setKeySet] = useState<boolean | null>(null);
  useEffect(() => { let current = true; const read = () => void coworkerBridge.calls.settings().then((settings) => { if (current) setKeySet(settings.keySet && settings.enabled); }).catch(() => { if (current) setKeySet(false); }); read(); window.addEventListener("coworker:call-settings-changed", read); return () => { current = false; window.removeEventListener("coworker:call-settings-changed", read); }; }, []);
  async function start() {
    if (!active || busy || !keySet) return;
    if (coworkerCall.isActive()) { coworkerCall.show(); return; }
    setBusy(true); setError("");
    // Main checks the saved key before reusing the existing microphone handler.
    // Send now so preload can stamp this click's transient user activation.
    const permission = coworkerBridge.calls.microphone().catch(() => ({ granted: false }));
    try { const settings = await coworkerBridge.calls.settings(); setKeySet(settings.keySet && settings.enabled); if (!settings.keySet || !settings.enabled) return; const id = threadId || await prepare?.(); if (id) await coworkerCall.start(person, id, permission); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The call could not start."); }
    finally { setBusy(false); }
  }
  action.current = () => void start();
  useEffect(() => active ? onSuperAction((action) => { if (action.kind === "call") actionRef(); }) : undefined, [active]);
  function actionRef() { action.current(); }
  const hint = keySet === null ? "Checking voice settings…" : !keySet ? "Add an OpenAI key and enable voice in Settings › OpenAI" : "Start a call · ⌥⌘C";
  return <span className="relative inline-flex" title={!keySet ? hint : undefined}><IconButton label="Start a call" tooltip={error || hint} tooltipSide="bottom" disabled={busy || !keySet} aria-keyshortcuts={keySet ? superKeyShortcut("C") : undefined} onClick={() => void start()} data-testid="coworker-start-call" className={state.target?.slug === person.slug && coworkerCall.isActive() ? "text-spark" : ""}><PhoneIcon /></IconButton>{superKey.active && keySet ? <span className="absolute -bottom-1 right-0 text-[8px]">C</span> : null}</span>;
}
export function CallScreen() {
  const state = useCallState();
  const [now, setNow] = useState(Date.now());
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputError, setOutputError] = useState("");
  const [threadOpen, setThreadOpen] = useState(false);
  const [threadAnchor, setThreadAnchor] = useState<HTMLElement | null>(null);
  const [outputAnchor, setOutputAnchor] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const avatar = useRef<SVGSVGElement | null>(null);
  const screen = useRef<HTMLDivElement | null>(null);
  const subtitleScroll = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { const resize = () => { setViewport({ width: window.innerWidth, height: window.innerHeight }); setThreadOpen(false); setOutputOpen(false); }; window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  useEffect(() => { if (!state.startedAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [state.startedAt]);
  useEffect(() => {
    if (!state.visible || !state.person) return;
    const active = document.activeElement; returnFocus.current = active instanceof HTMLElement ? active : null;
    screen.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    return () => { if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); };
  }, [state.visible, state.person?.slug]);
  useEffect(() => {
    if (!state.visible) return;
    let frame = 0; let level = 0; let drawnLevel = "";
    const draw = () => {
      const nextLevel = coworkerCall.audioLevel();
      level += (nextLevel - level) * .24;
      if (!nextLevel && level < .005) level = 0;
      const value = level.toFixed(3);
      if (value !== drawnLevel) { avatar.current?.style.setProperty("--call-mouth-level", value); screen.current?.style.setProperty("--call-audio-level", value); drawnLevel = value; }
      const current = coworkerCall.snapshot();
      const engagement = current.phase === "calling" ? "ringing" : coworkerCall.isHearingYou() ? "hearing" : current.phase === "speaking" ? "speaking" : current.phase === "thinking" || (current.observation.working && !current.observation.attention) ? "thinking" : "ready";
      if (screen.current && screen.current.dataset.engagement !== engagement) screen.current.dataset.engagement = engagement;
      frame = requestAnimationFrame(draw);
    }; draw();
    return () => cancelAnimationFrame(frame);
  }, [state.visible]);
  useEffect(() => { const text = subtitleScroll.current?.querySelector(".call-subtitle p"); if (text) text.scrollTop = text.scrollHeight; }, [state.subtitles]);
  useEffect(() => { const end = () => coworkerCall.end(); window.addEventListener("beforeunload", end); return () => window.removeEventListener("beforeunload", end); }, []);
  useEffect(() => { if (state.person && state.observation.failure) expressCoworker(`${state.person.slug}:call`, "sorry"); }, [state.person?.slug, state.observation.failure]);
  useEffect(() => { if (state.person && state.observation.reply) expressCoworker(`${state.person.slug}:call`, "happy"); }, [state.person?.slug, state.observation.reply?.id]);
  const person = state.person;
  if (!person || state.phase === "idle" || state.phase === "ended") return null;
  if (!state.visible) return <button type="button" className="call-return fixed right-5 top-10 z-[70] flex items-center gap-2 rounded-full bg-emerald-700 px-4 py-2 text-xs text-white shadow-lg" onClick={coworkerCall.show}><PhoneIcon />{person.name} · {state.startedAt ? callDuration(now - state.startedAt) : "Connecting"}</button>;
  const work = state.observation;
  const status = state.phase === "calling" ? `Calling ${person.name}…` : state.phase === "error" ? "Call ended" : state.phase === "speaking" ? "Speaking" : state.phase === "thinking" ? "Thinking" : state.muted ? "Microphone muted" : "Listening";
  const workText = work.working ? (work.doing || work.phase || "Working on it") : work.reply ? "Reply ready" : "Your conversation";
  const hasWork = work.working || work.reply || work.workers.length || work.tools.length || work.attention || work.failure;
  const compact = viewport.width < 860;
  const avatarSize = Math.round(state.phase === "error" ? 120 : viewport.height <= 650 ? Math.max(112, Math.min(180, viewport.height * .24)) : compact ? Math.max(120, Math.min(260, viewport.height * .3)) : Math.max(180, Math.min(320, viewport.height * .34)));
  return <div ref={screen} role="dialog" aria-modal="true" aria-label={`Call with ${person.name}`} className="call-screen fixed inset-0 z-[80] flex flex-col text-snow" style={{ "--call-color": avatarFill(person.avatarColor) } as CSSProperties} data-testid="coworker-call-screen" data-phase={state.phase} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); if (threadOpen) setThreadOpen(false); else if (outputOpen) setOutputOpen(false); else coworkerCall.type(); return; }
    if (event.key === "Tab") { const controls = Array.from(screen.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,a[href]') ?? []); const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>
    <header className="call-header window-controls-inset window-drag flex shrink-0 items-center justify-between">
      <span className="flex items-center gap-2 text-xs text-snow/60"><span className={`size-1.5 rounded-full ${state.startedAt ? "bg-emerald-300" : "bg-white/40"}`} />{state.startedAt ? "Live call" : "Open Coworker"}</span>
      <div className="window-no-drag flex gap-1"><button type="button" aria-expanded={threadOpen} aria-haspopup="dialog" className="call-header-action" onClick={(event) => { setThreadAnchor(event.currentTarget); setOutputOpen(false); setThreadOpen(!threadOpen); }}>Live thread</button><button type="button" className="call-header-action" onClick={() => void coworkerCall.minimize().catch(() => setOutputError("The bubble could not open. Your call is still connected."))}>Minimize ↘</button></div>
    </header>
    <main className="call-stage">
      <section className="call-presence">
        <div className="call-avatar" data-calling={state.phase === "calling"} data-speaking={state.phase === "speaking"}>
          <div className="call-avatar-halo" aria-hidden="true" />
          <CoworkerAvatar svgRef={avatar} name={person.name} identity={`${person.slug}:call`} color={person.avatarColor} glasses={person.avatarGlasses} size={avatarSize} motion="attentive" gaze={false} working={coworkerCall.isActive()} temperament={person.personality} expression={work.attention ? "curious" : state.phase === "thinking" || (work.working && state.phase !== "speaking") ? "thinking" : "none"} />
        </div>
        <div className="call-identity text-center"><h1 className="text-3xl font-semibold tracking-tight">{person.name}</h1><p className="mt-2 flex items-center justify-center gap-2 text-sm text-snow/75" role="status"><span className="call-level-bars shrink-0" aria-hidden="true" data-active={state.phase === "speaking" || state.phase === "listening"}><i /><i /><i /><i /><i /></span><span className="call-status">{status}</span><span className="shrink-0 text-snow/30">·</span><span className="shrink-0 tabular-nums text-snow/55">{state.startedAt ? callDuration(now - state.startedAt) : "Connecting"}</span></p></div>
        {hasWork ? <button type="button" className="call-work-summary inline-flex max-w-full items-center gap-2 rounded-full px-3 py-2 text-xs" title={workText} aria-expanded={threadOpen} aria-haspopup="dialog" onClick={(event) => { setThreadAnchor(event.currentTarget); setOutputOpen(false); setThreadOpen(!threadOpen); }}><span className="call-work-dot" data-working={work.working} /><span className="min-w-0 truncate">{workText}</span>{work.workers.some((worker) => worker.status === "running") ? <WorkersIcon className="size-3.5 shrink-0" /> : null}<span className="shrink-0" aria-hidden="true">›</span></button> : null}
        {state.captions && state.phase !== "error" ? <div ref={subtitleScroll} className="call-subtitles" aria-label="Live subtitles" aria-live="off" data-testid="coworker-call-subtitles">
          {state.subtitles.length ? state.subtitles.slice(-1).map((line) => <div key={line.id} className="call-subtitle" data-speaker={line.speaker}><span className="call-speaker">{line.speaker === "you" ? "You" : person.name}</span><p>{line.text}</p></div>) : <p className="call-subtitle-placeholder">{state.phase === "calling" ? "A moment to connect." : "Talk naturally. You can interrupt anytime."}</p>}
        </div> : null}
        {state.error || outputError ? <div role="alert" className="call-error"><p>{state.error || outputError}</p><button type="button" className="mt-2 underline" onClick={() => { coworkerCall.hide(); openCallSettings(); }}>OpenAI settings</button></div> : null}
      </section>

    </main>
    <footer className="call-footer window-no-drag mx-auto w-full max-w-md shrink-0 px-6 pb-7 pt-3">

      <div className="call-controls grid grid-cols-5 gap-2 text-center">
        <CallControl label="Mute" pressed={state.muted} disabled={state.phase === "error"} onClick={() => coworkerCall.toggleMute()}><ControlIcon kind={state.muted ? "muted" : "mic"} /></CallControl>
        <CallControl label="Audio" pressed={outputOpen} onClick={(event) => { setOutputAnchor(event.currentTarget); setThreadOpen(false); setOutputOpen(!outputOpen); void coworkerCall.outputs().then(setOutputs).catch(() => setOutputError("Use your system sound settings to choose an output.")); }}><ControlIcon kind="audio" /></CallControl>
        <CallControl label="Type" onClick={coworkerCall.type}><ControlIcon kind="type" /></CallControl>
        <CallControl label="Captions" pressed={state.captions} onClick={() => coworkerCall.toggleCaptions()}><ControlIcon kind="captions" /></CallControl>
        <CallControl label="End" end onClick={coworkerCall.end}><PhoneIcon end /></CallControl>
      </div>

    </footer>
    {threadOpen ? <CallPopover title="Live thread" anchor={threadAnchor} onClose={() => setThreadOpen(false)}><div className="call-thread" data-testid="coworker-call-thread">
        <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><span className="call-work-dot" data-working={work.working} /><span className="truncate text-xs font-medium">{workText}</span></div><button type="button" className="shrink-0 text-[11px] text-snow/55 hover:text-snow" onClick={coworkerCall.type}>Open thread ↗</button></div>
        <div className="call-thread-content">
          {work.stream || work.reply ? <div className="call-thread-reply"><p className="mb-3 text-[10px] uppercase tracking-[.14em] text-snow/40">{work.stream ? "Replying in your thread" : "Latest thread reply"}</p><ChatReply text={work.stream || work.reply?.text || ""} live={Boolean(work.stream)} /></div> : <p className="py-4 text-sm text-snow/50">{work.working ? `${person.name} is working. You can keep talking.` : "New work and replies will appear here."}</p>}
          {work.tools.length ? <div className="call-tools" aria-label="Tool activity">{work.tools.map((tool) => <div key={tool.id} className="call-tool"><ToolIcon className="size-3.5 text-snow/40" /><span className="flex-1">{tool.label}</span><span className="call-tool-status" data-status={tool.status}>{tool.status === "completed" ? "Done" : tool.status === "pending" ? "Queued" : tool.status === "running" ? "In progress" : tool.status}</span></div>)}</div> : null}
          {work.workers.length ? <div className="call-workers" aria-label="Workers">{work.workers.slice(-4).map((worker) => <div key={worker.id} className="call-tool"><WorkersIcon className="size-3.5 text-snow/40" /><span className="min-w-0 flex-1 truncate">{worker.name}</span><span className="call-tool-status" data-status={worker.status}>{worker.status}</span></div>)}</div> : null}
          {work.attention || work.failure ? <div className="call-attention"><p>{work.attention || work.failure}</p><button type="button" className="mt-2 underline" onClick={coworkerCall.type}>Review in conversation</button></div> : null}
        </div>
        <p className="call-thread-note">Work keeps going when you hang up.</p>
    </div></CallPopover> : null}
    {outputOpen ? <CallPopover title="Audio output" anchor={outputAnchor} onClose={() => setOutputOpen(false)}><label className="block text-xs">Play your coworker’s voice through<select className="mt-2 w-full rounded-xl bg-panel px-3 py-2 text-snow" onChange={(event) => void coworkerCall.output(event.target.value).catch(() => setOutputError("That audio output could not be selected. Try your system sound settings."))}><option value="">System default</option>{outputs.filter((device) => device.deviceId !== "default").map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Output ${index + 1}`}</option>)}</select></label></CallPopover> : null}
  </div>;
}
function CallControl({ label, children, onClick, pressed, disabled, end }: { label: string; children: ReactNode; onClick: (event: MouseEvent<HTMLButtonElement>) => void; pressed?: boolean; disabled?: boolean; end?: boolean }) { return <button type="button" aria-label={end ? "End call" : label} data-testid={end ? "coworker-end-call" : undefined} aria-pressed={pressed} disabled={disabled} onClick={onClick} className="call-control flex flex-col items-center gap-2 rounded-xl py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white disabled:opacity-40"><span className={`flex size-14 items-center justify-center rounded-full ${end ? "call-end bg-red-500 text-white" : pressed ? "bg-white text-black" : "bg-white/12"}`}>{children}</span>{label}</button>; }
function ControlIcon({ kind }: { kind: "mic" | "muted" | "audio" | "type" | "captions" }) {
  return <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "mic" || kind === "muted" ? <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />{kind === "muted" ? <path d="m3 3 18 18" /> : null}</> : kind === "audio" ? <><path d="m3 9 5 0 5-5v16l-5-5H3ZM17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14" /></> : kind === "type" ? <><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" /></> : <><rect x="2" y="4" width="20" height="16" rx="4" /><path d="M10 9a3 3 0 1 0 0 6M19 9a3 3 0 1 0 0 6" /></>}</svg>;
}

function CallPopover({ title, anchor, onClose, children }: { title: string; anchor: HTMLElement | null; onClose: () => void; children: ReactNode }) {
  const ref = useActivityPopover(anchor, onClose);
  const rect = anchor?.getBoundingClientRect();
  const ceiling = (document.querySelector(".call-header")?.getBoundingClientRect().bottom ?? 0) + 10;
  const floor = (document.querySelector(".call-footer")?.getBoundingClientRect().top ?? window.innerHeight) - 10;
  const roomAbove = (rect?.top ?? ceiling) - ceiling - 10;
  const roomBelow = floor - (rect?.bottom ?? ceiling) - 10;
  const above = roomAbove > roomBelow;
  const maxHeight = Math.max(64, Math.min(520, above ? roomAbove : roomBelow));
  const width = Math.min(420, window.innerWidth - 32);
  const left = Math.max(16, Math.min(window.innerWidth - width - 16, (rect?.right ?? window.innerWidth - 16) - width));
  return <div ref={ref} tabIndex={-1} role="dialog" aria-modal="false" aria-label={title} className="call-popover window-no-drag" style={{ width, left, maxHeight, ...(above ? { bottom: window.innerHeight - (rect?.top ?? 0) + 10 } : { top: (rect?.bottom ?? 0) + 10 }) }} data-testid="coworker-call-popover">
    <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-xs font-semibold">{title}</h2><button type="button" className="rounded px-1 text-xs text-snow/50 hover:text-snow" onClick={onClose}>Close</button></div>
    {children}
  </div>;
}
