"use client";

import type { Dispatch, SetStateAction } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Paperclip, Plus, Upload, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { fmtFull } from "@/lib/currency";
import { fmtAED, fmtINR, type Academy } from "@/lib/academy";
import { uploadReceipt } from "@/hooks/useStudents";
import { ENROLMENT_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentInAed, type StoredReceipt } from "@/types/student";

/*
 * The payments taken at a close, one row each (the user, 2026-10-05): a client
 * may pay part in cash and part by card, and each payment has its own method,
 * amount and receipt. The money already on the lead before the close is a row
 * of its own — its amount fixed, its method and receipt still asked, since
 * finance records every payment against the invoice with its proof.
 *
 * A Bangalore close is in INR (the user, 2026-10-10), and cash is sometimes
 * taken in AED: such a payment is typed in AED with the rate — 1 AED = so many
 * INR — and its INR figure worked out, or typed and the rate worked out from
 * it. The INR figure is what it counts as. The money already on the lead is
 * AED (the lead's own list is), so in a Bangalore close it is always such a
 * payment: its AED fixed, its rate asked.
 */

export interface PaymentRow {
  id: string;
  method: string;
  /** In the close's currency — or in AED, when `paidInAed`. */
  amountInput: string;
  receipt: StoredReceipt | null;
  /** A Bangalore close's payment taken in AED. */
  paidInAed?: boolean;
  /** Taken in AED: 1 AED = this many INR. */
  rateInput: string;
  /** Taken in AED: what it comes to in INR — the figure that counts. */
  convertedInput: string;
  /** The money already on the lead before the close, as one payment. */
  collectedBefore?: boolean;
  /** Already added to the lead's payments, by an attempt that then failed — not added twice. */
  addedToLead?: boolean;
  uploading?: boolean;
  uploadError?: string;
}

export const MAX_PAYMENTS = 10;

let rowSeq = 0;
export const newPaymentRow = (over: Partial<PaymentRow> = {}): PaymentRow => ({
  id: `payment-${++rowSeq}`,
  method: "",
  amountInput: "",
  receipt: null,
  rateInput: "",
  convertedInput: "",
  ...over,
});

const num = (s: string) => Math.max(0, Number(s) || 0);
/** Whole paise, as a plain number string. */
const toMoneyInput = (n: number) => String(Math.round(n * 100) / 100);
/** A rate worked out from two amounts, to ten significant figures. */
const toRateInput = (n: number) => String(Number(n.toPrecision(10)));

/** What the payment counts as, in the close's currency — the INR worked out when it was taken in AED. */
export const rowAmount = (r: PaymentRow) => (r.paidInAed ? num(r.convertedInput) : num(r.amountInput));

/** For the close: the AED handed over and its rate, when it was taken in AED — nothing otherwise. */
export function rowAedFields(r: PaymentRow): PaymentInAed {
  if (!r.paidInAed) return {};
  return { currency: "AED", amountInCurrency: num(r.amountInput), exchangeRate: num(r.rateInput) };
}

/**
 * The rows as an academy takes them, when the close switches academy: a Dubai
 * close is all AED; in a Bangalore one the money already on the lead is AED at
 * a rate, the rest INR until somebody says a payment was taken in AED.
 */
export function rowsForAcademy(rows: PaymentRow[], academy: Academy): PaymentRow[] {
  return rows.map((r) => ({
    ...r,
    paidInAed: academy === "bangalore" && Boolean(r.collectedBefore),
    rateInput: "",
    convertedInput: "",
  }));
}

/** What each payment still needs, the way the close's "Still needed" line says it. */
export function missingInRows(rows: PaymentRow[]): string[] {
  const one = rows.length === 1;
  return rows.flatMap((r, i) => {
    const whose = `payment ${i + 1}'s`;
    return [
      !r.method && (one ? "payment method" : `${whose} method`),
      !r.collectedBefore && !(num(r.amountInput) > 0) && (one ? "the amount paid" : `${whose} amount`),
      r.paidInAed && num(r.amountInput) > 0 && !(num(r.rateInput) > 0 && num(r.convertedInput) > 0) &&
        (one ? "the AED rate" : `${whose} AED rate`),
      !r.receipt && (one ? "payment receipt" : `${whose} receipt`),
    ].filter(Boolean) as string[];
  });
}

interface PaymentRowsEditorProps {
  leadId: string;
  rows: PaymentRow[];
  onChange: Dispatch<SetStateAction<PaymentRow[]>>;
  /** Bangalore: amounts in INR, any of them may be taken in AED at a rate. Dubai when not said. */
  academy?: Academy;
}

export function PaymentRowsEditor({ leadId, rows, onChange, academy = "dubai" }: PaymentRowsEditorProps) {
  const update = (id: string, patch: Partial<PaymentRow>) =>
    onChange((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const inr = academy === "bangalore";

  // Taken in AED: the rate and the INR figure follow each other — whichever was
  // typed last works out the other; a new AED amount keeps the rate.
  function setAmount(r: PaymentRow, amountInput: string) {
    const paid = num(amountInput);
    if (!r.paidInAed) return update(r.id, { amountInput });
    if (num(r.rateInput) > 0) return update(r.id, { amountInput, convertedInput: paid > 0 ? toMoneyInput(paid * num(r.rateInput)) : "" });
    if (num(r.convertedInput) > 0 && paid > 0) return update(r.id, { amountInput, rateInput: toRateInput(num(r.convertedInput) / paid) });
    update(r.id, { amountInput });
  }
  function setRate(r: PaymentRow, rateInput: string) {
    const paid = num(r.amountInput);
    const rate = num(rateInput);
    update(r.id, { rateInput, convertedInput: paid > 0 && rate > 0 ? toMoneyInput(paid * rate) : "" });
  }
  function setConverted(r: PaymentRow, convertedInput: string) {
    const paid = num(r.amountInput);
    const inrAmount = num(convertedInput);
    update(r.id, { convertedInput, rateInput: paid > 0 && inrAmount > 0 ? toRateInput(inrAmount / paid) : "" });
  }
  // Switching currency starts the rate afresh: no feed is trusted for it, the seller enters it.
  const setPaidInAed = (r: PaymentRow, paidInAed: boolean) => update(r.id, { paidInAed, rateInput: "", convertedInput: "" });

  async function attach(id: string, file: File) {
    update(id, { uploading: true, uploadError: "" });
    try {
      const receipt = await uploadReceipt(leadId, file);
      update(id, { receipt, uploading: false });
    } catch (e) {
      update(id, { uploading: false, uploadError: e instanceof Error ? e.message : "Could not upload that file" });
    }
  }

  const removable = rows.filter((r) => !r.collectedBefore).length > 1 || rows.some((r) => r.collectedBefore);

  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {rows.map((r, i) => (
          <motion.div
            key={r.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="space-y-1.5 rounded-lg border border-border/50 bg-muted/20 p-2"
          >
            <div className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-[10px] font-semibold text-muted-foreground">{i + 1}.</span>
              <Select value={r.method} onValueChange={(v) => update(r.id, { method: v })}>
                <SelectTrigger className="h-8 w-[130px] shrink-0 text-xs" aria-label={`Payment ${i + 1} method`}>
                  <SelectValue placeholder="Paid by…" />
                </SelectTrigger>
                <SelectContent>
                  {ENROLMENT_PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m} className="text-xs">{PAYMENT_METHOD_LABELS[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {r.collectedBefore ? (
                <div className="flex-1 text-xs">
                  {/* The lead's own list is AED: in a Bangalore close, its INR follows from the rate below. */}
                  <span className="font-semibold text-foreground">{inr ? fmtAED(num(r.amountInput)) : fmtFull(rowAmount(r))}</span>
                  <span className="ml-1.5 text-[10px] text-muted-foreground">already on the lead</span>
                </div>
              ) : (
                <>
                  {inr && (
                    <Select value={r.paidInAed ? "AED" : "INR"} onValueChange={(v) => setPaidInAed(r, v === "AED")}>
                      <SelectTrigger className="h-8 w-[76px] shrink-0 text-xs" aria-label={`Payment ${i + 1} currency`}>
                        <SelectValue>{r.paidInAed ? "AED" : "INR"}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="INR" className="text-xs">INR ₹</SelectItem>
                        <SelectItem value="AED" className="text-xs">Paid in AED</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  <Input
                    type="number" min="0" step="0.01" value={r.amountInput}
                    onChange={(e) => setAmount(r, e.target.value)}
                    placeholder={r.paidInAed ? "Amount in AED" : inr ? "Amount (₹)" : "Amount"} className="h-8 min-w-0 flex-1 text-xs"
                    aria-label={`Payment ${i + 1} amount${r.paidInAed ? " in AED" : inr ? " in INR" : ""}`}
                  />
                </>
              )}
              {!r.collectedBefore && removable && (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  onClick={() => onChange((prev) => prev.filter((x) => x.id !== r.id))}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-red-400"
                  aria-label={`Remove payment ${i + 1}`}
                >
                  <X className="h-3.5 w-3.5" />
                </motion.button>
              )}
            </div>
            {/* Taken in AED: the rate, and what it comes to in INR — the figure that counts. */}
            {inr && r.paidInAed && (
              <div className="flex flex-wrap items-center gap-1.5 pl-7 text-[11px] text-muted-foreground">
                <span>1 AED =</span>
                <Input
                  type="number" min="0" step="any" value={r.rateInput}
                  onChange={(e) => setRate(r, e.target.value)}
                  placeholder="rate" className="h-7 w-24 text-xs"
                  aria-label={`Payment ${i + 1}: 1 AED in INR`}
                />
                <span>INR →</span>
                <Input
                  type="number" min="0" step="0.01" value={r.convertedInput}
                  onChange={(e) => setConverted(r, e.target.value)}
                  placeholder="in INR" className="h-7 w-28 text-xs"
                  aria-label={`Payment ${i + 1} in INR`}
                />
                <span>{num(r.convertedInput) > 0 ? fmtINR(num(r.convertedInput)) : "INR"}</span>
              </div>
            )}
            {r.receipt ? (
              <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card px-2.5 py-1.5">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <a href={r.receipt.url} target="_blank" rel="noreferrer" className="flex-1 truncate text-xs hover:underline">
                  {r.receipt.name}
                </a>
                <button
                  type="button"
                  onClick={() => update(r.id, { receipt: null })}
                  className="text-[10px] text-muted-foreground hover:text-red-400"
                >
                  Replace
                </button>
              </div>
            ) : (
              <label
                className={cn(
                  "flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  r.uploading && "pointer-events-none opacity-60",
                )}
              >
                <Upload className="h-3.5 w-3.5" />
                {r.uploading ? "Uploading…" : "Attach this payment's receipt — photo or PDF"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void attach(r.id, f);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
            {r.uploadError && <p className="text-[10px] text-red-400">{r.uploadError}</p>}
          </motion.div>
        ))}
      </AnimatePresence>
      {rows.length < MAX_PAYMENTS && (
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          onClick={() => onChange((prev) => [...prev, newPaymentRow()])}
          className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> Add another payment
        </motion.button>
      )}
    </div>
  );
}
