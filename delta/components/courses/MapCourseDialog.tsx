"use client";

import { useEffect, useMemo, useState } from "react";
import { Link2, Sparkles, Loader2 } from "lucide-react";
import type { Course, FinanceItem, LmsCourse } from "@/types/course";
import { lmsCoursesOf } from "@/types/course";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useBangaloreOffered, useFinanceItems, useLmsCourses, useMapCourse } from "@/hooks/useCourses";
import { fmtINR } from "@/lib/academy";

/** Radix reads "" as unset, so "not mapped" needs a value of its own. */
const NONE = "__none__";

/** Letters and digits only: "MMC (Market Making Cycle)" and "mmc market making cycle" are one name. */
const normalise = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Where a Draw course goes when it is sold.
 *
 *   Finance product — the Delta Finance catalogue item the invoice line bills
 *   against. Unmapped, the line is typed text and finance flags it; the price
 *   billed is Draw's either way.
 *
 *   LMS courses — what the student gets once accounts approve the sale. A
 *   bundle opens more than one ("MBT + DWT"), in the order ticked. Unmapped,
 *   the sale is billed and nobody is enrolled.
 *
 * A same-name match is offered, never applied: "Digital Marketing" and
 * "Digital Marketing (Evening)" are one course to a comparison and two to
 * anybody reading them.
 *
 * And the same for the Bangalore academy (the user, 2026-10-10): its price in
 * INR — a Bangalore close starts its fee from it, and can't be made without
 * it — its product in the Bangalore finance organization, and its LMS
 * courses, which are the Dubai ones unless ticked otherwise (the Forex courses
 * are shared).
 */
export function MapCourseDialog({
  course,
  open,
  onClose,
}: {
  course: Course | null;
  open: boolean;
  onClose: () => void;
}) {
  const items = useFinanceItems(open);
  // The Bangalore side only where the server takes Bangalore closes — a server
  // from before would ignore it, and list Dubai's products as if Bangalore's.
  const { data: bangaloreOffered = false } = useBangaloreOffered(open);
  const bItems = useFinanceItems(open && bangaloreOffered, "bangalore");
  const lms = useLmsCourses(open);
  const save = useMapCourse();
  const [itemId, setItemId] = useState<string>(NONE);
  const [slugs, setSlugs] = useState<string[]>([]);
  // Bangalore
  const [bPrice, setBPrice] = useState("");
  const [bItemId, setBItemId] = useState<string>(NONE);
  const [bSlugs, setBSlugs] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !course) return;
    setItemId(course.financeItemId || NONE);
    setSlugs(lmsCoursesOf(course));
    setBPrice(course.bangalore?.price ? String(course.bangalore.price) : "");
    setBItemId(course.bangalore?.financeItemId || NONE);
    setBSlugs(course.bangalore?.lmsCourseSlugs ?? []);
  }, [open, course]);

  const itemSuggestion = useMemo<FinanceItem | undefined>(
    () => (course ? (items.data ?? []).find((i) => normalise(i.name) === normalise(course.name)) : undefined),
    [course, items.data],
  );
  const lmsSuggestion = useMemo<LmsCourse | undefined>(
    () => (course ? (lms.data ?? []).find((c) => normalise(c.title) === normalise(course.name)) : undefined),
    [course, lms.data],
  );

  if (!course) return null;

  const financeOff = !items.isLoading && !items.isError && (items.data?.length ?? 0) === 0;
  const bFinanceOff = !bItems.isLoading && !bItems.isError && (bItems.data?.length ?? 0) === 0;
  const lmsOff = !lms.isLoading && !lms.isError && (lms.data?.length ?? 0) === 0;
  const titleOf = (slug: string) => lms.data?.find((c) => c.slug === slug)?.title ?? slug;
  const toggleIn = (set: typeof setSlugs) => (slug: string, on: boolean) =>
    set((current) => (on ? (current.includes(slug) ? current : [...current, slug]) : current.filter((s) => s !== slug)));
  const toggle = toggleIn(setSlugs);
  const bToggle = toggleIn(setBSlugs);
  const bPriceValue = Number(bPrice);
  const bPriceBad = bPrice.trim() !== "" && !(Number.isFinite(bPriceValue) && bPriceValue >= 0);

  async function submit() {
    await save.mutateAsync({
      id: course!._id,
      financeItemId: itemId === NONE ? "" : itemId,
      lmsCourseSlugs: slugs,
      ...(bangaloreOffered
        ? {
            bangalore: {
              price: Number.isFinite(bPriceValue) && bPriceValue > 0 ? bPriceValue : null,
              financeItemId: bItemId === NONE ? "" : bItemId,
              lmsCourseSlugs: bSlugs,
            },
          }
        : {}),
    });
    onClose();
  }

  /** The LMS courses as ticks, in the order ticked. */
  const lmsPicker = (picked: string[], onToggle: (slug: string, on: boolean) => void) =>
    lms.isLoading ? (
      <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
    ) : lms.isError ? (
      <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        The LMS could not be read just now. Try again in a moment.
      </p>
    ) : lmsOff ? (
      <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        No LMS courses to choose from — the LMS address is not set on this server, or it has no published courses.
      </p>
    ) : (
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
        {(lms.data ?? []).map((c) => {
          const at = picked.indexOf(c.slug);
          return (
            <label key={c.slug} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50">
              <Checkbox checked={at >= 0} onCheckedChange={(v) => onToggle(c.slug, v === true)} />
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {at >= 0 && picked.length > 1 && (
                <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary">{at + 1}</span>
              )}
            </label>
          );
        })}
      </div>
    );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" /> Map course
          </DialogTitle>
          <DialogDescription>
            Where <span className="font-medium text-foreground">{course.name}</span> goes when it is sold: the product
            finance bills it as, and the LMS course(s) the student gets once the sale is approved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* ── Finance product ── */}
          <div className="space-y-1.5">
            <Label>Finance product</Label>
            {items.isError ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                Delta Finance could not be read just now. Try again in a moment.
              </p>
            ) : financeOff ? (
              <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                This server is not connected to Delta Finance yet, so there are no products to choose from.
              </p>
            ) : (
              <Select value={itemId} onValueChange={setItemId} disabled={items.isLoading}>
                <SelectTrigger>
                  <SelectValue placeholder={items.isLoading ? "Loading…" : "Not mapped"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not mapped</SelectItem>
                  {(items.data ?? []).map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}{i.sku ? ` · ${i.sku}` : ""} · {(i.unitPriceMinor / 100).toLocaleString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {itemSuggestion && itemId !== itemSuggestion.id && (
              <button
                type="button"
                onClick={() => setItemId(itemSuggestion.id)}
                className="flex w-full items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-left text-sm hover:bg-primary/10"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span>
                  Same name in finance: <span className="font-medium">{itemSuggestion.name}</span>
                  {itemSuggestion.sku ? ` (${itemSuggestion.sku})` : ""} — use it?
                </span>
              </button>
            )}
          </div>

          {/* ── LMS courses ── */}
          <div className="space-y-1.5">
            <Label>LMS course(s)</Label>
            <p className="text-xs text-muted-foreground">
              Tick every course a student gets for this one — two for a bundle. They are opened in the order ticked.
            </p>
            {lmsPicker(slugs, toggle)}
            {slugs.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Opens: <span className="font-medium text-foreground">{slugs.map(titleOf).join(" + ")}</span>
              </p>
            )}
            {lmsSuggestion && !slugs.includes(lmsSuggestion.slug) && (
              <button
                type="button"
                onClick={() => toggle(lmsSuggestion.slug, true)}
                className="flex w-full items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-left text-sm hover:bg-primary/10"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span>Same name in the LMS: <span className="font-medium">{lmsSuggestion.title}</span> — add it?</span>
              </button>
            )}
          </div>

          {/* ── Bangalore academy ── */}
          {bangaloreOffered && (
            <div className="space-y-4 rounded-lg border border-orange-500/25 bg-orange-500/[0.03] p-3">
              <div>
                <p className="text-sm font-semibold text-foreground">Bangalore academy</p>
                <p className="text-xs text-muted-foreground">
                  How a Bangalore close sells it — in rupees, billed by the Bangalore finance team. Without a price it can&apos;t be closed for Bangalore.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bangalore-price">Price (₹)</Label>
                <Input
                  id="bangalore-price" type="number" min="0" step="0.01" value={bPrice}
                  onChange={(e) => setBPrice(e.target.value)} placeholder="No Bangalore price"
                />
                {bPriceBad ? (
                  <p className="text-xs text-destructive">A price is a number, zero or more.</p>
                ) : bPriceValue > 0 ? (
                  <p className="text-xs text-muted-foreground">A Bangalore close starts its fee at {fmtINR(bPriceValue)}.</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label>Bangalore finance product</Label>
                {bItems.isError ? (
                  <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    The Bangalore finance organization could not be read just now. Try again in a moment.
                  </p>
                ) : bFinanceOff ? (
                  <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                    This server is not connected to the Bangalore finance organization yet, so there are no products to choose from.
                  </p>
                ) : (
                  <Select value={bItemId} onValueChange={setBItemId} disabled={bItems.isLoading}>
                    <SelectTrigger>
                      <SelectValue placeholder={bItems.isLoading ? "Loading…" : "Not mapped"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not mapped</SelectItem>
                      {(bItems.data ?? []).map((i) => (
                        <SelectItem key={i.id} value={i.id}>
                          {i.name}{i.sku ? ` · ${i.sku}` : ""} · {fmtINR(i.unitPriceMinor / 100)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Bangalore LMS course(s)</Label>
                <p className="text-xs text-muted-foreground">
                  Leave all unticked to open the same LMS course(s) as Dubai{slugs.length ? ` (${slugs.map(titleOf).join(" + ")})` : ""}.
                </p>
                {lmsPicker(bSlugs, bToggle)}
                <p className="text-xs text-muted-foreground">
                  Opens: <span className="font-medium text-foreground">
                    {(bSlugs.length ? bSlugs : slugs).map(titleOf).join(" + ") || "nothing yet"}
                  </span>
                  {!bSlugs.length && slugs.length ? " — the Dubai ones" : ""}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending || (bangaloreOffered && bPriceBad)}>
            {save.isPending ? "Saving…" : "Save mapping"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
