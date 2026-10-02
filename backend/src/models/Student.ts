import mongoose, { Schema } from "mongoose";
import type { IStudent } from "../types/index.js";

const studentSchema = new Schema<IStudent>(
  {
    enrollmentNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
    },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    courses: [{ type: Schema.Types.ObjectId, ref: "Course" }],
    team:   { type: Schema.Types.ObjectId, ref: "Team",   default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true, unique: true },

    // Lead insight fields (copied from lead at enrollment time)
    initialLeadResponse:  {
      type: String,
      enum: ["very_interested", "not_interested", "let_me_think", null],
      default: null,
    },
    primaryConcern: {
      type: String,
      enum: ["risk", "price", "time", "trust", "exact_concern", null],
      default: null,
    },
    followupStrategyType: {
      type: String,
      enum: ["risk_based", "price_based", "time_based", "trust_based", null],
      default: null,
    },
    demoScheduled:    { type: Boolean, default: false },
    demoAttended:     { type: Boolean, default: false },
    firstContactTime: { type: Date,    default: null },
    lastFollowupDate: { type: Date,    default: null },

    // Enrollment & fee
    enrollmentDate: { type: Date, default: Date.now },
    feeStatus: {
      type: String,
      enum: ["paid", "partial", "pending"],
      default: "pending",
    },
    totalFee:     { type: Number, default: 0, min: 0 },
    paidAmount:   { type: Number, default: 0, min: 0 },
    pendingAmount:{ type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["active", "inactive", "graduated", "dropped"],
      default: "active",
    },
    language: { type: String, enum: ["English", "Malayalam", "Hindi/Urdu", "Tamil"] },
    paymentMethod: {
      type: String,
      enum: ["cash", "bank_transfer", "cheque", "card", "easebuzz_emi", "tabby", "tamara", "billexpro"],
    },
    /**
     * Proof the money was taken, uploaded at the close and required there.
     *
     * Optional on the model all the same: enrolments from before this CRM had
     * storage to put one in have none, and must keep loading. The requirement
     * lives at the close (StudentService.createStudent), as Delta CRM's does.
     */
    paymentReceipt: {
      name: { type: String },
      url: { type: String },
      key: { type: String },
      size: { type: Number },
      mimeType: { type: String },
      uploadedAt: { type: Date },
    },
    notes: { type: String, trim: true, maxlength: 2000 },
    /**
     * Whether the client was given a bonus with this enrolment, and how much.
     *
     * Asked at the close, and required there — yes or no, with the amount when
     * yes. Information beside the money, never in it: the bonus is not part of
     * the fee, of what was paid, or of the balance (fee − paid). Unset on
     * enrolments from before it was asked, which is different from "no".
     */
    hasBonus: { type: Boolean },
    bonusAmount: { type: Number, min: 0, default: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

studentSchema.index({ leadId: 1 }, { unique: true });
studentSchema.index({ enrollmentNumber: 1 }, { unique: true });
studentSchema.index({ courses: 1 });
studentSchema.index({ team: 1 });
studentSchema.index({ assignedTo: 1 });
studentSchema.index({ status: 1 });
studentSchema.index({ feeStatus: 1 });
studentSchema.index({ createdAt: -1 });

export const Student = mongoose.model<IStudent>("Student", studentSchema);
