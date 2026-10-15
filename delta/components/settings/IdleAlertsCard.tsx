"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { Clock, Loader2, Save, Info, ArrowRight, Coffee } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/store/authStore";
import { useAppSettings, useUpdateAppSettings } from "@/hooks/useAppSettings";
import type { AppSettings } from "@/types/settings";

// ── Types ──────────────────────────────────────────────────────────────────────
/** What the card edits. */
type Draft = Pick<AppSettings, "idleAlerts" | "workingHours">;

interface DurationInputProps {
  id: string;
  minutes: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
  maxHours: number;
}

interface SectionProps {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_ZONES = [
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Asia/Riyadh", label: "Riyadh (AST)" },
  { value: "Europe/London", label: "London" },
  { value: "UTC", label: "UTC" },
];
const sectionVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const draftOf = (s: AppSettings): Draft => ({
  idleAlerts: { ...s.idleAlerts },
  workingHours: { ...s.workingHours, days: [...s.workingHours.days] },
});

// ── Component ──────────────────────────────────────────────────────────────────
/**
 * "Idle alerts" on the Settings page (2026-10-15, as in the Sales CRM's
 * "Automation & alerts"): when someone at work has gone quiet in the CRM, and
 * the working hours that counts in. This CRM tells people in the bell while it
 * is open and by push — no email.
 *
 * Ships switched off. Shown to those with Settings view — the Settings page
 * itself is open to everyone — and changed only by those with Settings edit;
 * the rest see it read-only.
 */
export function IdleAlertsCard() {
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  // The signed-in user comes from localStorage: decide only once in the browser, so the server's HTML matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const canView = mounted && Boolean(user) && hasPermission("settings", "view");
  const canEdit = canView && hasPermission("settings", "edit");
  const { data, isLoading, error } = useAppSettings(canView);
  const save = useUpdateAppSettings();

  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (data) setDraft(draftOf(data.settings));
  }, [data]);

  const dirty = useMemo(
    () => Boolean(data && draft && JSON.stringify(draftOf(data.settings)) !== JSON.stringify(draft)),
    [data, draft]
  );

  const problems = useMemo(() => {
    if (!draft) return [];
    const p: string[] = [];
    if (draft.idleAlerts.limitMinutes < 5) p.push("The idle limit must be at least 5 minutes.");
    if (draft.idleAlerts.limitMinutes > 24 * 60) p.push("The idle limit can be at most 24 hours.");
    if (!draft.workingHours.days.length) p.push("Pick at least one working day.");
    const { start, end } = draft.workingHours;
    if (!HHMM.test(start) || !HHMM.test(end)) p.push("Set both working-hour times.");
    else if (minutesOf(end) <= minutesOf(start)) p.push("Working hours must end after they start.");
    // Quiet time counts within one working day, so a longer limit could never be reached.
    else if (draft.idleAlerts.enabled && draft.idleAlerts.limitMinutes >= minutesOf(end) - minutesOf(start)) {
      p.push("The idle limit must be shorter than the working day, or it could never fire.");
    }
    return p;
  }, [draft]);

  if (!canView) return null;
  if (isLoading || (!draft && !error)) {
    return (
      <Card className="border-border/50 bg-card/80">
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (error || !draft || !data) {
    return (
      <Card className="border-border/50 bg-card/80">
        <CardContent className="p-6 text-sm text-muted-foreground">Could not load the idle-alert settings.</CardContent>
      </Card>
    );
  }

  const set = <K extends keyof Draft>(group: K, patch: Partial<Draft[K]>) =>
    setDraft((d) => (d ? { ...d, [group]: { ...d[group], ...patch } } : d));

  const toggleDay = (day: number) =>
    set("workingHours", {
      days: draft.workingHours.days.includes(day)
        ? draft.workingHours.days.filter((d) => d !== day)
        : [...draft.workingHours.days, day].sort((a, b) => a - b),
    });

  return (
    <Card className="border-border/50 bg-card/80">
      <CardHeader className="pb-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Coffee className="h-4 w-4 text-primary" />
          Idle alerts
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Be told when someone at work has gone quiet in the CRM. Off until you switch it on.
        </p>
        {!canEdit && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" /> You can see these but not change them.
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ── Idle alerts ── */}
        <Section
          icon={Coffee}
          title="When someone goes quiet"
          description="Alert the employee and the super admins when someone who used the app today, and hasn't signed out, has done nothing in it for a while during working hours — only while they are clocked in on the HRMS (by activity alone if the HRMS isn't linked); never on leave. Quiet time counts from when they clocked back in, so lunch isn't idle time. One alert per quiet stretch; super admins aren't tracked. In the bell while the CRM is open, and by push — no email."
        >
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="idle-enabled" className="text-sm">Send idle alerts</Label>
            <Switch
              id="idle-enabled"
              checked={draft.idleAlerts.enabled}
              onCheckedChange={(v) => set("idleAlerts", { enabled: v })}
              disabled={!canEdit}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">After no activity for</span>
            <DurationInput
              id="idle-limit"
              minutes={draft.idleAlerts.limitMinutes}
              onChange={(m) => set("idleAlerts", { limitMinutes: m })}
              disabled={!canEdit}
              maxHours={24}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={draft.idleAlerts.notifyTeamLeaders}
              onCheckedChange={(v) => set("idleAlerts", { notifyTeamLeaders: v === true })}
              disabled={!canEdit}
            />
            Also alert the person&apos;s team leaders
          </label>
          {hasPermission("activity", "view") && (
            <div className="flex justify-end text-xs">
              <Link href="/activity" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                See who&apos;s active <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          )}
        </Section>

        {/* ── Working hours ── */}
        <Section icon={Clock} title="Working hours" description="Idle alerts only run inside these hours, in this time zone — by default 10:00–19:00 GST, Monday to Saturday.">
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((label, day) => {
              const on = draft.workingHours.days.includes(day);
              return (
                <motion.button
                  key={label}
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  onClick={() => toggleDay(day)}
                  disabled={!canEdit}
                  aria-pressed={on}
                  className={cn(
                    "h-8 min-w-[3rem] rounded-full border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
                  )}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 sm:gap-3">
              <Input
                type="time"
                aria-label="Start"
                value={draft.workingHours.start}
                onChange={(e) => set("workingHours", { start: e.target.value })}
                disabled={!canEdit}
                className="w-28 dark:[color-scheme:dark] sm:w-32"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="time"
                aria-label="End"
                value={draft.workingHours.end}
                onChange={(e) => set("workingHours", { end: e.target.value })}
                disabled={!canEdit}
                className="w-28 dark:[color-scheme:dark] sm:w-32"
              />
            </div>
            <Select
              value={draft.workingHours.timezone}
              onValueChange={(v) => set("workingHours", { timezone: v })}
              disabled={!canEdit}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Time zone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_ZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Section>

        {/* ── Save ── */}
        {canEdit && (
          <div className="flex flex-col gap-3 border-t border-border/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <AnimatePresence>
              {problems.length > 0 && (
                <motion.ul
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="space-y-0.5 text-xs text-destructive"
                  role="alert"
                >
                  {problems.map((p) => <li key={p}>{p}</li>)}
                </motion.ul>
              )}
            </AnimatePresence>
            <div className="flex gap-2 sm:ml-auto">
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button variant="ghost" size="sm" disabled={!dirty || save.isPending} onClick={() => setDraft(draftOf(data.settings))}>
                  Discard
                </Button>
              </motion.div>
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button size="sm" className="gap-1.5" disabled={!dirty || problems.length > 0 || save.isPending} onClick={() => save.mutate(draft)}>
                  {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save changes
                </Button>
              </motion.div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function Section({ icon: Icon, title, description, children }: SectionProps) {
  return (
    <motion.section variants={sectionVariants} initial="hidden" animate="visible" className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {/* Under the heading from a tablet up; full width on a phone, where 44px is an eighth of the screen. */}
      <div className="space-y-3 sm:pl-11">{children}</div>
    </motion.section>
  );
}

/** Hours and minutes, stored as minutes. */
function DurationInput({ id, minutes, onChange, disabled, maxHours }: DurationInputProps) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const clamp = (v: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), 0), max) : 0);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        id={`${id}-hours`}
        type="number"
        inputMode="numeric"
        min={0}
        max={maxHours}
        value={hours}
        onChange={(e) => onChange(clamp(Number(e.target.value), maxHours) * 60 + mins)}
        disabled={disabled}
        className="w-20"
        aria-label="Hours"
      />
      <span className="text-sm text-muted-foreground">h</span>
      <Input
        id={`${id}-minutes`}
        type="number"
        inputMode="numeric"
        min={0}
        max={59}
        value={mins}
        onChange={(e) => onChange(hours * 60 + clamp(Number(e.target.value), 59))}
        disabled={disabled}
        className="w-20"
        aria-label="Minutes"
      />
      <span className="text-sm text-muted-foreground">min</span>
    </div>
  );
}
