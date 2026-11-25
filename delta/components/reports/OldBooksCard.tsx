"use client";

import { BookOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOldBooks } from "@/hooks/useReports";
import { fmtFull } from "@/lib/currency";

/**
 * "Old books collected" (2026-11-25): instalments on finance's old-books invoices (sales from before the CRM) paid
 * in the range, counted for their salesperson here. Already inside Total Received and every ranking; this lists them.
 * Hidden when there are none.
 */
export function OldBooksCard({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const { data } = useOldBooks(dateFrom, dateTo);
  if (!data || data.count === 0) return null;
  return (
    <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" /> Old books collected
          </span>
          <span className="tabular-nums text-emerald-500">{fmtFull(data.total)}</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {data.count} instalment{data.count === 1 ? "" : "s"} on finance&apos;s old books · counted in revenue
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="divide-y divide-border/50">
          {data.rows.map((r, i) => (
            <li key={`${r.invoiceNumber}-${r.paidAt}-${i}`} className="flex items-center justify-between gap-3 py-2 text-xs">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">{r.name}</span>
                <span className="text-muted-foreground"> · {r.invoiceNumber} · {r.course || "—"}</span>
              </span>
              <span className="shrink-0 tabular-nums font-semibold text-foreground">{fmtFull(r.amount)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
