"use client";
import { motion } from "framer-motion";
import { Phone, PhoneOff } from "lucide-react";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { CallsPanel } from "@/components/leads/CallsPanel";
import { cn } from "@/lib/utils";
import type { InactiveLead } from "@/types/inactiveLeads";

/** The lead's full 3CX call log — the same panel as on the lead page. */
export function LeadCallsDialog({ lead, onClose }: { lead: InactiveLead | null; onClose: () => void }) {
  return (
    <ResponsiveDialog open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent className="max-w-3xl">
        {lead && (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{lead.name || "Unnamed lead"} — call log</ResponsiveDialogTitle>
              <ResponsiveDialogDescription className="font-mono">{lead.phone}</ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            {/* On a phone the sheet's scroll area grows to its widest child, so pin the
                body to the screen — the call table then scrolls sideways inside it. */}
            <div className="w-[100vw] max-h-[70vh] overflow-y-auto px-4 pb-4 md:w-auto md:px-0 [&_.overflow-x-auto]:max-w-full [&>*]:min-w-0">
              <CallsPanel leadId={lead.id} phone={lead.phone} leadName={lead.name} />
            </div>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** "3 calls · 1 answered" — opens the call log. Every 3CX call on record for the lead. */
export function CallCountButton({ lead, onOpen, className }: { lead: InactiveLead; onOpen: () => void; className?: string }) {
  const { total, answered } = lead.calls ?? { total: 0, answered: 0 };
  const none = total === 0;
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      onClick={onOpen}
      title={none ? "No 3CX calls on record — open the call log" : "Open the full call log"}
      aria-label={`${total} call${total === 1 ? "" : "s"}, ${answered} answered — open the call log for ${lead.name || lead.phone}`}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        none
          ? "border-border/60 text-muted-foreground hover:bg-muted/40"
          : "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10",
        className,
      )}
    >
      {none ? <PhoneOff className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
      {none ? (
        "No calls"
      ) : (
        <>
          <span className="font-semibold tabular-nums">{total}</span>
          <span className="text-muted-foreground">· {answered} answered</span>
        </>
      )}
    </motion.button>
  );
}
