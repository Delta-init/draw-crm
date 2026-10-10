import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACADEMY_LABELS, academyOf } from "@/lib/academy";

/**
 * Which academy an enrolment was closed for — Dubai or Bangalore — beside its
 * name wherever it is shown. Bangalore stands out: its money is in rupees.
 */
export function AcademyBadge({ academy, className }: { academy?: string | null; className?: string }) {
  const a = academyOf(academy);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        a === "bangalore"
          ? "border-orange-500/25 bg-orange-500/10 text-orange-600 dark:text-orange-400"
          : "border-border/50 bg-muted/30 text-muted-foreground",
        className,
      )}
      title={a === "bangalore" ? "Closed for the Bangalore academy — in INR" : "Closed for the Dubai academy"}
    >
      <MapPin className="h-2.5 w-2.5" /> {ACADEMY_LABELS[a]}
    </span>
  );
}
