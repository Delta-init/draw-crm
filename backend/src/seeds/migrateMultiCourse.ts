/**
 * Migration: single `course` → `courses[]` on leads & students.
 *
 * - Docs with a real course ObjectId  → courses = [course], then drop `course`.
 * - Docs with null/leftover `course`  → courses = (existing courses ?? []), then drop `course`.
 *
 * Idempotent: re-running only touches docs that still have a `course` field.
 * Uses the native driver (the Mongoose models no longer map `course`).
 *
 * Run locally:
 *   MONGODB_URI=mongodb://localhost:27017/crm_db bun src/seeds/migrateMultiCourse.ts
 * Run on prod: set MONGODB_URI to the production connection string.
 */
import "dotenv/config";
import mongoose from "mongoose";

const URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/crm_db";

async function migrate() {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect");
  console.log(`🔗 Connected: ${db.databaseName}`);

  for (const name of ["leads", "students"]) {
    const coll = db.collection(name);

    // 1. Real course ObjectId → courses: [course]
    const moved = await coll.updateMany(
      { course: { $type: "objectId" } },
      [{ $set: { courses: ["$course"] } }, { $unset: "course" }],
    );

    // 2. Any leftover `course` (null / non-ObjectId) → ensure courses[], drop course
    const cleaned = await coll.updateMany(
      { course: { $exists: true } },
      [{ $set: { courses: { $ifNull: ["$courses", []] } } }, { $unset: "course" }],
    );

    const total = await coll.countDocuments({});
    const withCourses = await coll.countDocuments({ courses: { $exists: true } });
    console.log(
      `📦 ${name}: moved=${moved.modifiedCount} cleaned=${cleaned.modifiedCount} | ${withCourses}/${total} now have courses[]`,
    );
  }

  await mongoose.disconnect();
  console.log("✅ Migration complete");
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
