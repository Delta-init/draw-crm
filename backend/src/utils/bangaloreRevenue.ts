import type { PipelineStage } from "mongoose";
import { getAppSettings } from "../services/settingsService.js";

/*
 * A Bangalore enrolment's money in the revenue figures (the user, 2026-10-28: "Ria's INR payment is not in the
 * leaderboard, the Sales TV, the Manager TV or the reports" — as in the Sales CRM).
 *
 * Every revenue figure adds up the lead's payments, and those are AED. A close for the Bangalore academy is paid in
 * rupees, so the close puts none of it on the lead (CreateStudentModal; a correction neither — studentService): its
 * payments live only on the enrolment, and the close counted as a closing with no money. Here those payments join
 * the lead's own, in AED: a payment taken in AED cash at its AED (`currency: "AED"`, `amountInCurrency`), every
 * rupee one at the Settings rate (1 AED = ₹ `bangaloreRevenue.inrPerAed`, 22.75 until changed). Nothing stored
 * changes; a new rate re-prices every month.
 *
 * Not counted: a payment already on the lead before the close (`collectedBefore` — the lead counts it), and an
 * enrolment that was dropped (as the closings leave it out). Credited as the lead's own payments are: to whoever
 * holds the lead, in its team.
 */

export const DEFAULT_INR_PER_AED = 22.75;

/** Stages that may also go inside a `$unionWith` (Draw's rankings add up payments in one). */
type Stage = Exclude<PipelineStage, PipelineStage.Out | PipelineStage.Merge>;

/** The rate the revenue figures turn rupees into dirhams at: 1 AED = this many rupees. */
export async function inrPerAed(): Promise<number> {
  const rate = (await getAppSettings()).bangaloreRevenue?.inrPerAed;
  return typeof rate === "number" && rate > 0 ? rate : DEFAULT_INR_PER_AED;
}

/** An enrolment's payments as lead payments in AED (an older close with no list: its paid amount, on its date). */
function paymentsInAed(rate: number) {
  const list = {
    $cond: [
      { $gt: [{ $size: { $ifNull: ["$payments", []] } }, 0] },
      "$payments",
      [{ amount: { $ifNull: ["$paidAmount", 0] }, paidAt: "$enrollmentDate" }],
    ],
  };
  // Draw keeps an AED-cash payment as currency "AED" + amountInCurrency (its AED), with `amount` the rupees.
  const aedCash = { $and: [{ $eq: ["$$p.currency", "AED"] }, { $gt: [{ $ifNull: ["$$p.amountInCurrency", 0] }, 0] }] };
  return {
    $filter: {
      input: {
        $map: {
          input: { $filter: { input: list, as: "p", cond: { $ne: ["$$p.collectedBefore", true] } } },
          as: "p",
          in: {
            amount: {
              $round: [
                { $cond: [aedCash, "$$p.amountInCurrency", { $divide: [{ $ifNull: ["$$p.amount", 0] }, rate] }] },
                2,
              ],
            },
            paidAt: { $ifNull: ["$$p.paidAt", "$enrollmentDate"] },
            method: "$$p.method",
            note: {
              $concat: [
                "Bangalore enrolment · ",
                {
                  $cond: [
                    aedCash,
                    { $concat: ["AED ", { $toString: "$$p.amountInCurrency" }, " cash"] },
                    { $concat: ["₹", { $toString: { $ifNull: ["$$p.amount", 0] } }, " at 1 AED = ₹", { $toString: rate }] },
                  ],
                },
              ],
            },
            bangalore: true,
          },
        },
      },
      as: "p",
      cond: { $gt: ["$$p.amount", 0] },
    },
  };
}

/** A lead's rupee payments (`currency: "INR"`) in AED, with the rest of each — finance's decision included. */
function rupeesInAed(payments: string, rate: number) {
  return {
    $map: {
      input: { $filter: { input: { $ifNull: [payments, []] }, as: "p", cond: { $eq: ["$$p.currency", "INR"] } } },
      as: "p",
      in: rupeePaymentInAed(rate),
    },
  };
}

/** One rupee payment (`$$p`) in AED — no longer marked INR, so the counted-payment rule takes it. */
function rupeePaymentInAed(rate: number) {
  return {
    $mergeObjects: [
      { $arrayToObject: { $filter: { input: { $objectToArray: "$$p" }, as: "f", cond: { $ne: ["$$f.k", "currency"] } } } },
      {
        amount: { $round: [{ $divide: [{ $ifNull: ["$$p.amount", 0] }, rate] }, 2] },
        note: { $concat: ["Bangalore balance payment · ₹", { $toString: { $ifNull: ["$$p.amount", 0] } }, " at 1 AED = ₹", { $toString: rate }] },
        bangalore: true,
      },
    ],
  };
}

const BANGALORE_ENROLMENT = { academy: "bangalore", status: { $ne: "dropped" } };

/**
 * For a pipeline that unwinds lead payments (revenue by the day a payment was made): put first, it adds — beside the
 * leads — one copy of each Bangalore-enrolled lead carrying only the enrolment's payments and the lead's rupee ones,
 * in AED. The lead's AED payments still come from the lead itself, and its rupee ones are left out there, so nothing
 * is counted twice; a count of leads must not use this.
 */
export async function bangaloreLeadsUnion(): Promise<Stage[]> {
  const rate = await inrPerAed();
  return [
    {
      $unionWith: {
        coll: "students",
        pipeline: [
          { $match: BANGALORE_ENROLMENT },
          { $project: { leadId: 1, payments: paymentsInAed(rate) } },
          { $lookup: { from: "leads", localField: "leadId", foreignField: "_id", as: "lead", pipeline: [{ $project: { activityLogs: 0 } }] } },
          { $unwind: "$lead" },
          { $replaceWith: { $mergeObjects: ["$lead", { payments: { $concatArrays: ["$payments", rupeesInAed("$lead.payments", rate)] } }] } },
          { $match: { "payments.0": { $exists: true } } },
        ],
      },
    },
  ];
}

/**
 * For a pipeline that adds up each lead's payments (COUNTED_TOTAL): put after its $match, it adds the lead's
 * Bangalore enrolment payments, in AED, to its `payments`, and turns its rupee ones into AED.
 */
export async function withBangaloreMoney(): Promise<Stage[]> {
  const rate = await inrPerAed();
  return [
    {
      $lookup: {
        from: "students",
        localField: "_id",
        foreignField: "leadId",
        as: "_bangalore",
        pipeline: [{ $match: BANGALORE_ENROLMENT }, { $project: { payments: paymentsInAed(rate) } }],
      },
    },
    {
      $set: {
        payments: {
          $concatArrays: [
            { $map: { input: { $ifNull: ["$payments", []] }, as: "p", in: { $cond: [{ $eq: ["$$p.currency", "INR"] }, rupeePaymentInAed(rate), "$$p"] } } },
            { $reduce: { input: "$_bangalore.payments", initialValue: [], in: { $concatArrays: ["$$value", "$$this"] } } },
          ],
        },
      },
    },
    { $unset: "_bangalore" },
  ];
}
