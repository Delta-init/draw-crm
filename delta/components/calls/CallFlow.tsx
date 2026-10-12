"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, PhoneCall, PhoneOff, Smartphone, StickyNote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CloseLeadDialog } from "@/components/students/CloseLeadDialog";
import { useLead } from "@/hooks/useLeads";
import { useClickToCall, type MyCallState, type PlacedCall } from "@/hooks/useCalls";
import { useAuthStore } from "@/lib/store/authStore";
import { LEAD_STATUSES, STATUS_META, type LeadStatus } from "@/lib/statusConfig";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";

/* ────────────────────────────────────────────────────────────────────────────
   Call, then say how it went — Tetra Commission's call flow
   (frontend/src/components/followups/CallFlow.jsx there), for leads
   (2026-10-12). One set of dialogs for the whole app, mounted by the
   dashboard layout; every Call button (ClickToCall) goes through it.

     1. Call pressed: "3CX call" (when 3CX is connected and the caller's
        extension is known) — 3CX rings their own 3CX app / web client, they
        answer, and 3CX dials the lead — or "Phone call" (tel:).
     2. A 3CX call: the call window follows it from 3CX (ringing, calling,
        connected with a timer, ended) and can hang up.
     3. After the call (it ended, "Log call" pressed, or a phone call chosen):
        "How did the call go?" — connected yes / no, the lead's next status
        through Draw's own paths (Follow Up and Callback with the reminder's
        date and time; Closed through the enrolment dialog; Lost with a
        reason; any other status as it is), and notes, saved as a lead note
        (with its activity). It can be put aside ("Later"): the pending one is
        kept in this tab (sessionStorage, 30 minutes) and opens again after a
        reload. Only for calls started here, and only for someone who may edit
        leads.

   The counts on the lead (calls / connected / not connected) come from 3CX by
   themselves; nothing here counts.
──────────────────────────────────────────────────────────────────────────── */

export interface CallTarget {
  leadId?:   string;
  leadName?: string;
  phone:     string;
}

interface PendingLog {
  at:        number;
  leadId:    string;
  leadName:  string;
  phone:     string;
  via:       "3cx" | "phone";
  /** What the 3CX call window saw: true connected, false ended unconnected, null not known. */
  connected: boolean | null;
}

const PENDING = "drawcrm.pendingCallLog";
const PENDING_FOR_MS = 30 * 60_000;
const keepPending = (p: PendingLog) => { try { sessionStorage.setItem(PENDING, JSON.stringify(p)); } catch { /* the popup still opens now */ } };
const readPending = (): PendingLog | null => {
  try {
    const p = JSON.parse(sessionStorage.getItem(PENDING) || "null") as PendingLog | null;
    return p && p.leadId && Date.now() - p.at < PENDING_FOR_MS ? p : null;
  } catch { return null; }
};
const dropPending = () => { try { sessionStorage.removeItem(PENDING); } catch { /* nothing kept */ } };

/** The digits (and a leading +) of the first number written in a phone field. */
export function dialOf(raw: string): string {
  const first = String(raw ?? "").split(/[\n\r/,;|]+| - /).map((x) => x.trim()).find((x) => x.replace(/\D/g, "").length >= 7) ?? "";
  return first.replace(/[^\d+]/g, "");
}

const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
const firstName = (name?: string) => String(name || "").trim().split(/\s+/)[0] || "the lead";
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

interface CallFlowValue {
  /** A Call button was pressed: ask how to call. */
  chooseCall: (target: CallTarget) => void;
}

const CallFlowContext = createContext<CallFlowValue | null>(null);
export const useCallFlow = () => useContext(CallFlowContext);

export function CallFlowProvider({ children }: { children: React.ReactNode }) {
  useAuthStore((s) => s.user);   // re-check when the signed-in user changes
  const canLog = useAuthStore((s) => s.hasPermission)("leads", "edit");
  const [choice, setChoice] = useState<CallTarget | null>(null);
  const [live, setLive] = useState<(PlacedCall & { phone: string }) | null>(null);
  const [pending, setPending] = useState<PendingLog | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);   // a lead whose enrolment dialog is open

  // Back after a reload: the call still to log opens again.
  useEffect(() => {
    const p = readPending();
    if (p) { setPending(p); setLogOpen(true); }
  }, []);

  const startLog = useCallback((p: PendingLog, open: boolean) => {
    if (!canLog) return;
    keepPending(p);
    setPending(p);
    setLogOpen(open);
  }, [canLog]);

  /** The 3CX call ended, or Log call was pressed: its popup. */
  const logLive = useCallback((connected: boolean | null) => {
    const c = live;
    setLive(null);
    if (!c) return;
    const p = readPending() ?? { at: Date.now(), leadId: c.leadId, leadName: c.leadName, phone: c.phone, via: "3cx" as const, connected: null };
    startLog({ ...p, connected }, true);
  }, [live, startLog]);

  const chooseCall = useCallback((t: CallTarget) => setChoice(t), []);
  const value = useMemo(() => ({ chooseCall }), [chooseCall]);

  return (
    <CallFlowContext.Provider value={value}>
      {children}

      <CallChoiceDialog
        target={choice}
        onClose={() => setChoice(null)}
        onPhone={() => {
          const t = choice;
          setChoice(null);
          if (t?.leadId) startLog({ at: Date.now(), leadId: t.leadId, leadName: t.leadName ?? "", phone: t.phone, via: "phone", connected: null }, true);
        }}
        onStarted={(call) => {
          const t = choice;
          setChoice(null);
          if (!t?.leadId) return;
          setLive({ ...call, phone: t.phone });
          // Kept from the start: a reload during the call still brings back its log.
          startLog({ at: Date.now(), leadId: t.leadId, leadName: t.leadName || call.leadName, phone: t.phone, via: "3cx", connected: null }, false);
        }}
      />

      <CallWindow
        call={live}
        onClose={() => setLive(null)}
        onLog={logLive}
      />

      {pending && logOpen && (
        <AfterCallDialog
          key={`${pending.leadId}-${pending.at}`}
          pending={pending}
          onLater={() => setLogOpen(false)}
          onSaved={(closeNext) => {
            dropPending();
            setPending(null);
            setLogOpen(false);
            if (closeNext) setClosing(pending.leadId);
          }}
        />
      )}

      {/* Put aside: a small reminder that brings the popup back. */}
      {pending && !logOpen && !live && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full border border-border bg-card py-1 pl-3 pr-1 shadow-lg">
          <button type="button" onClick={() => setLogOpen(true)} className="flex items-center gap-2 text-xs font-medium text-foreground">
            <StickyNote className="h-3.5 w-3.5 text-primary" />
            Log your call with {pending.leadName || "the lead"}
          </button>
          <button
            type="button"
            title="Don't log this call"
            onClick={() => { dropPending(); setPending(null); }}
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {closing && <CloseAfterCall leadId={closing} onDone={() => setClosing(null)} />}
    </CallFlowContext.Provider>
  );
}

/* ── 1. How to call ─────────────────────────────────────────────────────── */

const OPTION = "flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors";

function CallChoiceDialog({ target, onClose, onPhone, onStarted }: {
  target: CallTarget | null;
  onClose: () => void;
  onPhone: () => void;
  onStarted: (call: PlacedCall) => void;
}) {
  const { data: c2c } = useClickToCall(!!target);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; webClientUrl?: string } | null>(null);
  useEffect(() => { setBusy(false); setProblem(null); }, [target]);
  const dial = dialOf(target?.phone ?? "");
  const can3cx = !!c2c?.enabled && !!target?.leadId;

  // The old click log (call_logs) — kept as it was; never stops a call.
  const logClick = () => {
    void api.post(`/calls/click?phone_number=${encodeURIComponent(target?.phone ?? "")}${target?.leadId ? `&lead_id=${target.leadId}` : ""}`).catch(() => null);
  };

  const call3cx = async () => {
    if (!target?.leadId) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.post<ApiResponse<PlacedCall>>("/calls/3cx/call", { leadId: target.leadId, dial });
      logClick();
      onStarted(res.data.data!);
    } catch (e) {
      const data = (e as { response?: { data?: { message?: string; errors?: { webClientUrl?: string } } } })?.response?.data;
      setProblem({ text: data?.message ?? "3CX could not place the call", webClientUrl: data?.errors?.webClientUrl });
    } finally {
      setBusy(false);
    }
  };

  const why3cxOff = !target?.leadId ? "Only for a lead's number"
    : !c2c ? "Checking 3CX…"
    : !c2c.connected ? "3CX is not connected on the server"
    : "No 3CX extension on your account — an admin adds it on the Users screen";

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Call {target?.leadName || target?.phone}</DialogTitle>
          <DialogDescription>{target?.phone}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <button
            type="button"
            disabled={!can3cx || busy}
            onClick={call3cx}
            className={`${OPTION} ${can3cx ? "border-emerald-500/40 hover:bg-emerald-500/10" : "cursor-not-allowed border-border opacity-60"}`}
          >
            {busy ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-emerald-500" /> : <PhoneCall className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />}
            <span>
              <span className="block font-semibold text-foreground">3CX call</span>
              <span className="block text-sm text-muted-foreground">
                {can3cx
                  ? `3CX rings your 3CX app or web client (extension ${c2c!.extension}) — answer it, then ${firstName(target?.leadName)} is dialled. The call shows here too.`
                  : why3cxOff}
              </span>
            </span>
          </button>
          <a
            href={`tel:${dial}`}
            onClick={() => { logClick(); setTimeout(onPhone, 0); }}   // the browser follows the link before this closes
            className={`${OPTION} border-border hover:bg-muted/50`}
          >
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <span>
              <span className="block font-semibold text-foreground">Phone call</span>
              <span className="block text-sm text-muted-foreground">Opens your phone app to dial {dial || target?.phone}</span>
            </span>
          </a>
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(target?.phone ?? ""); toast.success("Phone number copied"); }}
            className="flex w-full items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Copy className="h-3 w-3" /> Copy number
          </button>
          {problem && (
            <p className="text-sm text-red-400">
              {problem.text}
              {problem.webClientUrl && (
                <> — <a href={problem.webClientUrl} target="_blank" rel="noreferrer" className="underline">open the 3CX web client</a></>
              )}
            </p>
          )}
          {can3cx && c2c?.webClientUrl && !problem && (
            <a href={c2c.webClientUrl} target="_blank" rel="noreferrer" className="block text-center text-xs font-medium text-emerald-500 underline">
              Open the 3CX web client
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── 2. The call window ─────────────────────────────────────────────────── */

/**
 * A 3CX call as 3CX has it, every 2 seconds — ringing your app, calling the lead, connected (with a timer), ended —
 * with Hang up and Log call. Closing it does not end the call. Once the call has ended, the "How did it go?" popup
 * opens by itself.
 */
function CallWindow({ call, onClose, onLog }: {
  call: (PlacedCall & { phone: string }) | null;
  onClose: () => void;
  onLog: (connected: boolean | null) => void;
}) {
  const [state, setState] = useState<MyCallState | null>(null);
  const [ended, setEnded] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  const [hanging, setHanging] = useState(false);
  const [, setTick] = useState(0);
  const seen = useRef(false);
  const started = useRef(0);

  useEffect(() => {   // a new call: start over
    setState(null); setEnded(false); setConnectedAt(null); setProblem(""); setHanging(false);
    seen.current = false;
    started.current = Date.now();
  }, [call]);

  useEffect(() => {   // follow it until it ends
    if (!call || ended) return undefined;
    let gone = false;
    const look = async () => {
      try {
        const res = await api.get<ApiResponse<MyCallState>>("/calls/3cx/state", { params: { callId: call.callId ?? "", dial: call.dial } });
        if (gone) return;
        const s = res.data.data ?? null;
        setState(s);
        setProblem("");
        if (s?.participant) {
          seen.current = true;
          if (s.participant.stage === "connected") setConnectedAt((at) => at ?? Date.now());
        } else if (seen.current || Date.now() - started.current > 60_000) {
          setEnded(true);
        }
      } catch (e) {
        if (!gone) setProblem(errText(e, "Could not read the call from 3CX"));
      }
    };
    void look();
    const id = setInterval(look, 2000);
    return () => { gone = true; clearInterval(id); };
  }, [call, ended]);

  useEffect(() => {   // the talk timer
    if (!connectedAt || ended) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [connectedAt, ended]);

  // Ended: straight on to "How did the call go?", after a moment to read "Call ended".
  useEffect(() => {
    if (!ended || !call) return undefined;
    const id = setTimeout(() => onLog(connectedAt ? true : seen.current ? false : null), 1200);
    return () => clearTimeout(id);
  }, [ended, call, connectedAt, onLog]);

  const hangUp = async () => {
    if (!state?.participant?.id) return;
    setHanging(true);
    try {
      await api.post("/calls/3cx/hang-up", { participantId: state.participant.id });
      setEnded(true);
    } catch (e) {
      setProblem(errText(e, "Could not hang up"));
    } finally {
      setHanging(false);
    }
  };

  const stage = state?.participant?.stage;
  const where = call?.device || "3CX app";
  const name = firstName(call?.leadName);
  const line = ended ? (connectedAt ? "Call ended" : "The call ended before it connected")
    : !state?.participant ? `Ringing your ${where}…`
    : stage === "connected" ? `Connected · ${clock(Date.now() - (connectedAt ?? Date.now()))}`
    : stage === "calling" ? `Calling ${name}…`
    : stage === "ringing" ? `Ringing your ${where}…`
    : state.participant.status;
  // 3CX's "Dialing" covers both steps — your app ringing, then the lead's phone — so say what has to happen.
  const hint = connectedAt ? ""
    : !ended ? `Answer 3CX's call in your ${where} — then ${name}'s phone rings.`
    : `If 3CX's call didn't reach your ${where}, open it, let it use the microphone and call again — or use Phone call.`;

  return (
    <Dialog open={!!call} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader className="items-center text-center sm:text-center">
          <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${ended ? "bg-muted text-muted-foreground" : "bg-emerald-500/15 text-emerald-500"}`}>
            {ended ? <PhoneOff className="h-6 w-6" /> : <PhoneCall className={`h-6 w-6 ${connectedAt ? "" : "animate-pulse"}`} />}
          </div>
          <DialogTitle>{call?.leadName || call?.dial}</DialogTitle>
          <DialogDescription>{call?.dial} · from your extension {call?.extension}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1 text-center">
          <p className={`text-lg font-semibold ${ended ? "text-muted-foreground" : "text-emerald-500"}`}>{line}</p>
          {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
          {state?.participant?.status && !ended && (
            <p className="text-xs text-muted-foreground/70">3CX: {state.participant.status}{state.participant.party ? ` · ${state.participant.party}` : ""}</p>
          )}
          {!ended && <p className="text-xs text-muted-foreground/70">The call is on your 3CX app — closing this window does not end it.</p>}
          {problem && <p className="text-xs text-red-400">{problem}</p>}
        </div>
        <DialogFooter className="gap-2 sm:justify-center">
          {!ended && (
            <Button variant="destructive" onClick={hangUp} disabled={hanging || !state?.participant?.id}>
              {hanging ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />} Hang up
            </Button>
          )}
          <Button variant={ended ? "default" : "outline"} onClick={() => onLog(connectedAt ? true : ended && seen.current ? false : null)}>Log call</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── 3. How did the call go? ────────────────────────────────────────────── */

const KEEP = "__keep__";
/** Statuses that ask when to call again — Draw's reminder (date and time, GST). */
const ASKS_WHEN: Partial<Record<LeadStatus, { required: boolean; title: string }>> = {
  followup: { required: true, title: "Follow-up call" },
  callback: { required: false, title: "Call back" },
};

/** "2026-10-14T15:00" (GST) → "14 Oct, 3:00 PM". */
const fmtLocal = (v: string) =>
  new Date(`${v}:00+04:00`).toLocaleString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

function AfterCallDialog({ pending, onLater, onSaved }: {
  pending: PendingLog;
  onLater: () => void;
  /** Saved; `closeNext` — Closed was picked: the enrolment dialog opens next. */
  onSaved: (closeNext: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: lead } = useLead(pending.leadId);
  const [connected, setConnected] = useState<boolean | null>(pending.connected);
  const [status, setStatus] = useState<string>(KEEP);
  const [remindAt, setRemindAt] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const next = status === KEEP ? null : (status as LeadStatus);
  const when = next ? ASKS_WHEN[next] : undefined;
  const current = lead?.status;

  const save = async () => {
    setProblem("");
    if (connected === null) { setProblem("Did the call connect?"); return; }
    if (when?.required && !remindAt) { setProblem("When is the follow-up? Pick a date and time."); return; }
    setBusy(true);
    const id = pending.leadId;
    try {
      // The reminder first: a time it refuses (in the past) stops here, with nothing else saved.
      if (when && remindAt) {
        await api.post(`/leads/${id}/reminders`, { title: when.title, note: notes.trim().slice(0, 1000) || undefined, remindAt: `${remindAt}:00+04:00` });
      }
      // Closed waits for the enrolment (CloseLeadDialog), as everywhere else.
      if (next && next !== "closed" && next !== current) {
        await api.patch(`/leads/${id}/status`, { status: next });
      }
      const summary = [
        `Call ${pending.via === "3cx" ? "through 3CX" : "by phone"} — ${connected ? "connected" : "not connected"}`,
        next ? `${next === "closed" ? "closing" : STATUS_META[next].label}${when && remindAt ? `, ${fmtLocal(remindAt)} GST` : ""}` : "",
      ].filter(Boolean).join(" · ");
      const content = [summary, next === "lost" && reason.trim() ? `Lost — reason: ${reason.trim()}` : "", notes.trim()]
        .filter(Boolean).join("\n").slice(0, 2000);
      await api.post(`/leads/${id}/notes`, { content });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["reminders"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      toast.success(next === "closed" ? "Call logged — now the enrolment" : "Call logged");
      onSaved(next === "closed");
    } catch (e) {
      setProblem(errText(e, "Could not save — try again"));
      qc.invalidateQueries({ queryKey: ["leads"] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onLater(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>How did the call go?</DialogTitle>
          <DialogDescription>
            {pending.leadName || lead?.name || "The lead"} · {pending.phone}
            {current ? ` · now ${STATUS_META[current]?.label ?? current}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Did it connect?</Label>
            <div className="grid grid-cols-2 gap-2">
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  onClick={() => setConnected(v)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${connected === v
                    ? v ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-500" : "border-orange-500/60 bg-orange-500/15 text-orange-400"
                    : "border-border text-muted-foreground hover:bg-muted/50"}`}
                >
                  {v ? "Yes, we talked" : "No, not connected"}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Lead status</Label>
            <Select value={status} onValueChange={(v) => { setStatus(v); setProblem(""); }}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP} className="text-sm">Keep as it is{current ? ` (${STATUS_META[current]?.label ?? current})` : ""}</SelectItem>
                {LEAD_STATUSES.filter((s) => s !== current).map((s) => (
                  <SelectItem key={s} value={s} className="text-sm">{STATUS_META[s].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {when && (
            <div className="space-y-1.5">
              <Label className="text-xs">{next === "followup" ? "Follow-up on *" : "Call back on (optional)"} — GST</Label>
              <Input type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} className="h-9 [color-scheme:dark]" />
              <p className="text-[11px] text-muted-foreground">Saved as a reminder on the lead, as Add Reminder does.</p>
            </div>
          )}
          {next === "lost" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Why lost?</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Too expensive, chose another academy…" className="h-9" />
            </div>
          )}
          {next === "closed" && (
            <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
              Saving opens the enrolment form. The lead closes only when the enrolment is saved, as everywhere else.
            </p>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1500} placeholder="What did they say?" className="min-h-[80px] resize-none text-sm" />
            <p className="text-[11px] text-muted-foreground">Saved as a note on the lead, with what you picked above.</p>
          </div>

          {problem && <p className="text-sm text-red-400">{problem}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onLater} disabled={busy}>Later</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {next === "closed" ? "Save and enrol" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Closed picked after a call: the lead's enrolment dialog; the status changes only once it is saved. */
function CloseAfterCall({ leadId, onDone }: { leadId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: lead } = useLead(leadId);
  if (!lead) return null;
  return (
    <CloseLeadDialog
      key={lead._id}
      lead={lead}
      onClose={onDone}
      onClosed={async () => {
        onDone();
        if (lead.status === "closed") return;
        try {
          await api.patch(`/leads/${lead._id}/status`, { status: "closed" });
          toast.success("Status updated");
        } catch (e) {
          toast.error(errText(e, "Failed to update status"));
        }
        qc.invalidateQueries({ queryKey: ["leads"] });
        qc.invalidateQueries({ queryKey: ["teams"] });
      }}
    />
  );
}
