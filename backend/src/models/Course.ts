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
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    /** The finance catalogue item this course bills against, once mapped. */
    financeItemId: { type: String, default: null },
    /** Which course this is in the LMS, for provisioning a student on approval. */
    lmsCourseSlug: { type: String, default: "", trim: true },
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
