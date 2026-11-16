import { Types } from "mongoose";
import { Lead } from "../models/Lead.js";
import { Student } from "../models/Student.js";
import { User } from "../models/User.js";
import { CommissionSale } from "../models/CommissionSale.js";
import { CommissionSettings } from "../models/CommissionSettings.js";
import type { IRole } from "../types/index.js";

/*
 * A closed sale left out of every sales figure (the user, 2026-11-16: "remove this 11k on the Manager TV and Sales
 * TV, and exclude it from the sales also — only that 11k, only that closing").
 *
 * Marked on the lead (one close per lead: Student.leadId is unique), with who, when and why; copied onto each of its
 * payments and onto its enrolment, so every count leaves it out (utils/countedPayments.ts: COUNTED_PAYMENT,
 * COUNTED_PAYMENTS / COUNTED_TOTAL, COUNTED_STUDENT) — revenue, closings, the Sales TV and Manager TV, the
 * leaderboard, team pages, reports, exports, daily closings, rewards. Its commission sale is reversed (as a voided
 * invoice's is) and given its state back when the mark is taken off. Nothing is deleted: the lead, its payments, the
 * enrolment and finance's invoice stay as they are. Only a Super Admin or the Sales Manager marks or unmarks.
 */

export class NotCountedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const isSuperAdmin = (role?: IRole | null) => Boolean(role?.isSystemRole && role.roleName === "Super Admin");

/** A Super Admin, or the commission plan's Sales Manager. */
export async function mayMarkNotCounted(user: { userId: string; role?: IRole }): Promise<boolean> {
  if (isSuperAdmin(user.role)) return true;
  const s = await CommissionSettings.findOne({ key: "default" }).select("salesManager").lean<{ salesManager?: Types.ObjectId | null } | null>();
  return !!s?.salesManager && String(s.salesManager) === user.userId;
}

export interface NotCountedState {
  leadId: string;
  notCountedInSales: { at: string; byName: string; reason: string } | null;
  /** What it held back: the payments that would count, in AED, and whether it is a close. */
  amount: number;
  commission: string | null;
}

async function stateOf(leadId: Types.ObjectId): Promise<NotCountedState> {
  const lead = await Lead.findById(leadId).select("notCountedInSales payments").lean<any>();
  const sale = await CommissionSale.findOne({ student: (await Student.findOne({ leadId }).select("_id").lean<any>())?._id ?? null })
    .select("state").lean<any>();
  const nc = lead?.notCountedInSales;
  return {
    leadId: String(leadId),
    notCountedInSales: nc?.at ? { at: new Date(nc.at).toISOString(), byName: String(nc.byName ?? ""), reason: String(nc.reason ?? "") } : null,
    amount: Math.round(((lead?.payments ?? []) as any[]).filter((p) => p.currency !== "INR").reduce((n, p) => n + (Number(p.amount) || 0), 0) * 100) / 100,
    commission: sale?.state ?? null,
  };
}

/** Leave a closed sale out of the sales figures. */
export async function markNotCounted(leadId: string, user: { userId: string; role?: IRole }, reasonIn: string): Promise<NotCountedState> {
  if (!(await mayMarkNotCounted(user))) throw new NotCountedError("Only a Super Admin or the Sales Manager leaves a sale out of the sales", 403);
  if (!Types.ObjectId.isValid(leadId)) throw new NotCountedError("Lead not found", 404);
  const reason = String(reasonIn ?? "").trim().slice(0, 300);
  if (reason.length < 3) throw new NotCountedError("Say why it is not counted", 400);
  const id = new Types.ObjectId(leadId);
  const lead = await Lead.findById(id).select("notCountedInSales name").lean<any>();
  if (!lead) throw new NotCountedError("Lead not found", 404);
  if (lead.notCountedInSales?.at) throw new NotCountedError("This sale is not counted already", 409);
  const student = await Student.findOne({ leadId: id }).select("_id").lean<any>();
  if (!student) throw new NotCountedError("Only a closed sale (one with an enrolment) is left out of the sales", 409);

  const me = await User.findById(user.userId).select("name").lean<{ name?: string } | null>();
  const mark = { at: new Date(), byId: new Types.ObjectId(user.userId), byName: String(me?.name ?? ""), reason };
  const done = await Lead.updateOne(
    { _id: id, "notCountedInSales.at": { $exists: false } },
    {
      $set: { notCountedInSales: mark, "payments.$[].notCounted": true },
      $push: {
        activityLogs: {
          action: "sale_not_counted",
          description: `Sale left out of the sales figures: ${reason}`.slice(0, 500),
          performedBy: mark.byId,
          createdAt: mark.at,
        },
      },
    },
  );
  if (!done.modifiedCount) throw new NotCountedError("This sale is not counted already", 409);
  await Student.updateOne({ _id: student._id }, { $set: { notCountedInSales: mark } });
  // Its commission: reversed, as a voided invoice's is — and given back on undo.
  const sale = await CommissionSale.findOne({ student: student._id }).select("state").lean<any>();
  if (sale && sale.state !== "reversed") {
    await CommissionSale.updateOne({ _id: sale._id }, {
      $set: { state: "reversed", reversedAt: mark.at, reason: `Not counted in sales: ${reason}`.slice(0, 300), notCountedFrom: sale.state },
    });
  }
  return stateOf(id);
}

/** Count it again, as it was. */
export async function markCounted(leadId: string, user: { userId: string; role?: IRole }): Promise<NotCountedState> {
  if (!(await mayMarkNotCounted(user))) throw new NotCountedError("Only a Super Admin or the Sales Manager counts a sale again", 403);
  if (!Types.ObjectId.isValid(leadId)) throw new NotCountedError("Lead not found", 404);
  const id = new Types.ObjectId(leadId);
  const lead = await Lead.findById(id).select("notCountedInSales").lean<any>();
  if (!lead) throw new NotCountedError("Lead not found", 404);
  if (!lead.notCountedInSales?.at) throw new NotCountedError("This sale is counted already", 409);
  const me = await User.findById(user.userId).select("name").lean<{ name?: string } | null>();
  await Lead.updateOne(
    { _id: id },
    {
      $unset: { notCountedInSales: "", "payments.$[].notCounted": "" },
      $push: {
        activityLogs: {
          action: "sale_counted",
          description: `Sale counted in the sales figures again${me?.name ? ` (by ${me.name})` : ""}`,
          performedBy: new Types.ObjectId(user.userId),
          createdAt: new Date(),
        },
      },
    },
  );
  const student = await Student.findOne({ leadId: id }).select("_id").lean<any>();
  if (student) {
    await Student.updateOne({ _id: student._id }, { $unset: { notCountedInSales: "" } });
    // Only the reversal this mark made is undone — never one finance made (a voided invoice).
    const sale = await CommissionSale.findOne({ student: student._id, state: "reversed", notCountedFrom: { $exists: true } }).select("notCountedFrom").lean<any>();
    if (sale) {
      await CommissionSale.updateOne({ _id: sale._id }, {
        $set: { state: sale.notCountedFrom, reason: "" },
        $unset: { reversedAt: "", notCountedFrom: "" },
      });
    }
  }
  return stateOf(id);
}

/** Where a lead's close stands, and whether this person may change it — for the lead page. */
export async function notCountedStatus(leadId: string, user: { userId: string; role?: IRole }): Promise<NotCountedState & { closed: boolean; mayMark: boolean }> {
  if (!Types.ObjectId.isValid(leadId)) throw new NotCountedError("Lead not found", 404);
  const id = new Types.ObjectId(leadId);
  if (!(await Lead.exists({ _id: id }))) throw new NotCountedError("Lead not found", 404);
  const [state, closed, mayMark] = await Promise.all([stateOf(id), Student.exists({ leadId: id }), mayMarkNotCounted(user)]);
  return { ...state, closed: !!closed, mayMark };
}
