import mongoose, { Schema } from "mongoose";
import type { ICourse } from "../types/index.js";

const courseSchema = new Schema<ICourse>(
  {
    name: {
      type: String,
      required: [true, "Course name is required"],
      trim: true,
      maxlength: [150, "Course name cannot exceed 150 characters"],
      unique: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, "Description cannot exceed 1000 characters"],
    },
    amount: {
      type: Number,
      required: [true, "Course amount is required"],
      min: [0, "Amount cannot be negative"],
    },
    /**
     * The bonus a client gets with this course, in US dollars — an MT5 bonus,
     * USD in every sales CRM since 2026-10-09 (one set before is the number
     * it was given as); 0 when it comes with none. A new close starts from it — the
     * seller still answers, and can change it for a sale that differs.
     */
    bonusAmount: { type: Number, min: [0, "Bonus cannot be negative"], default: 0 },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    /** The finance catalogue item this course bills against, once mapped. */
    financeItemId: { type: String, default: null },
    /** Which course this is in the LMS, for provisioning a student on approval — the first of `lmsCourseSlugs`. */
    lmsCourseSlug: { type: String, default: "", trim: true },
    /**
     * Every LMS course it opens, in order — two for a bundle like "MBT + DWT",
     * which is one course to sell and two to study. Set on the Courses page
     * ("Map"), and sent with every enrolment so finance opens them all.
     */
    lmsCourseSlugs: { type: [String], default: [] },

    /**
     * What selling this course earns, in AED per approved sale: the closer
     * (Sales Staff), the leader of their team (TL) and the Sales Manager (SM).
     * `creditUsd` is the MT5 credit the course comes with, shown beside it.
     *
     * Set on the Commission page's plan by a Super Admin, never through the
     * course form — the course form is open to whoever edits courses, and what
     * people are paid is not theirs to set. A sale keeps the amounts it was
     * approved under, so changing them here never rewrites a past month.
     */
    commission: {
      sales: { type: Number, min: 0, default: 0 },
      tl: { type: Number, min: 0, default: 0 },
      sm: { type: Number, min: 0, default: 0 },
      creditUsd: { type: Number, min: 0, default: 0 },
      updatedAt: { type: Date },
      updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// name already declares unique on the field itself, which builds this same
// index — declaring it again warned on every boot for nothing.
courseSchema.index({ status: 1 });

export const Course = mongoose.model<ICourse>("Course", courseSchema);
