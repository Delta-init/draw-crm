"use client";

import { useState } from "react";
import { EyeOff, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useCountInSales, useLeaveOutOfSales, useNotCounted } from "@/hooks/useNotCounted";
import { fmtCurrency } from "@/lib/currency";

/*
 * "Don't count in sales" on a closed lead (the user, 2026-11-16: "only that 11k, only that closing"): a Super Admin or
 * the Sales Manager leaves this close out of every sales figure — the Sales TV and Manager TV, the leaderboard, team
 * pages, reports, daily closings, commission and rewards — with a reason, and can count it again. The lead, its
 * payments, the enrolment and finance stay as they are.
 */
export function NotCountedBox({ leadId, closed }: { leadId: string; closed: boolean }) {
  const { data } = useNotCounted(leadId, closed);
  const leave = useLeaveOutOfSales(leadId);
  const count = useCountInSales(leadId);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  if (!data?.closed) return null;
  const nc = data.notCountedInSales;

  if (nc) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-0.5">
            <p className="flex items-center gap-1.5 font-semibold text-amber-400"><EyeOff className="h-3.5 w-3.5" /> Not counted in sales</p>
            <p className="text-muted-foreground">
              Left out of the TVs, leaderboard, team pages, reports, daily closings, commission and rewards.
            </p>
            <p className="text-muted-foreground">
              {nc.byName ? `By ${nc.byName}` : "Marked"} · {new Date(nc.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
              {nc.reason ? ` — “${nc.reason}”` : ""}
            </p>
          </div>
          {data.mayMark && (
            <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1 text-xs" disabled={count.isPending} onClick={() => count.mutate()}>
              <RotateCcw className="h-3 w-3" /> Count again
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (!data.mayMark) return null;
  return (
    <>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground hover:text-amber-400" onClick={() => setAsking(true)}>
          <EyeOff className="h-3 w-3" /> Don&apos;t count in sales
        </Button>
      </div>
      <AlertDialog open={asking} onOpenChange={(o) => { if (!leave.isPending) setAsking(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Don&apos;t count this sale?</AlertDialogTitle>
            <AlertDialogDescription>
              {data.amount > 0 ? `${fmtCurrency(data.amount)} and this closing` : "This closing"} stay on the lead and in finance, but are left out of
              the Sales TV, Manager TV, leaderboard, team pages, reports, daily closings, commission and rewards. You can count it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? — e.g. closed by the team leader, not a sales close" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leave.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={leave.isPending || reason.trim().length < 3}
              onClick={() => leave.mutate(reason.trim(), { onSuccess: () => { setAsking(false); setReason(""); } })}
            >
              {leave.isPending ? "Saving…" : "Don't count"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
