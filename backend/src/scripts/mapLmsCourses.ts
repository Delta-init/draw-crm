/**
 * Give each Draw course the LMS course(s) a student gets when it is approved.
 *
 * The courses travel with every enrolment, and finance's approval opens them
 * all — two for a bundle like "MBT + DWT". A course with none gives an
 * approved enrolment, no student in the LMS, and a provisioning row in finance
 * reading "No LMS course is mapped".
 *
 * The same can be done one course at a time on the Courses page ("Map"); this
 * is for doing them all at once. The matching is the dangerous part, not the
 * writing: enrolling somebody on the wrong course is worse than not enrolling
 * them at all. So only an exact match is ever applied — names normalised to
 * lowercase letters and digits, and equal after that. Everything else is
 * printed as a suggestion for a person to confirm with --set, and a course
 * that already has LMS courses is never touched without --force.
 *
 * The LMS list is read from its public course list (LMS_API_URL), so this maps
 * against the courses that actually exist rather than a list copied out weeks
 * ago.
 *
 *   bun src/scripts/mapLmsCourses.ts                          # what it would do
 *   bun src/scripts/mapLmsCourses.ts --apply                  # exact matches only
 *   bun src/scripts/mapLmsCourses.ts --set "COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT)=market-break-out-trading-program" --apply
 *   bun src/scripts/mapLmsCourses.ts --set "COURSE 2 - MBT + DWT (WITH CREDIT)=market-break-out-trading-program,delta-wave-theory-trading-programme" --apply
 *
 * Everything after the last "=" is the course or courses, as slugs or titles,
 * separated by commas; the first is the one a single-course reader sees.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Course } from "../models/Course.js";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const SETS = process.argv.reduce<string[]>(
  (acc, a, i) => (a === "--set" && process.argv[i + 1] ? [...acc, process.argv[i + 1]!] : acc),
  [],
);

/** Letters and digits only: "MMC (MARKET MAKING CYCLE)" and "mmc market making cycle" are the same name. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("MONGODB_URI is not set."); process.exit(1); }
  await mongoose.connect(uri, { authSource: "admin" });

  const { listLmsCourses } = await import("../services/lmsClient.js");
  const remote = await listLmsCourses();
  if (remote.length === 0) {
    console.error("No LMS courses to map to — is LMS_API_URL set, and are the courses published?");
    process.exit(1);
  }
  console.log(`LMS courses:  ${remote.length}`);
  const byName = new Map(remote.map((c) => [norm(c.title), c]));

  const courses = await Course.find({}).select("name status lmsCourseSlug lmsCourseSlugs").lean();
  console.log(`Draw courses: ${courses.length}\n`);

  const exact: { id: string; name: string; slug: string }[] = [];
  const manual: { name: string; near: { slug: string; title: string }[] }[] = [];
  const done: string[] = [];

  for (const c of courses) {
    const name = String(c.name ?? "");
    const current = (c.lmsCourseSlugs?.length ? c.lmsCourseSlugs : c.lmsCourseSlug ? [c.lmsCourseSlug] : []).filter(Boolean);
    if (current.length && !FORCE) { done.push(`${name} → ${current.join(" + ")}`); continue; }

    const hit = byName.get(norm(name));
    if (hit) { exact.push({ id: String(c._id), name, slug: hit.slug }); continue; }

    /* Not applied, only offered. A name that merely contains another is how a
       foundation course gets mapped to the advanced one. */
    const n = norm(name);
    const near = remote.filter((r) => n && (norm(r.title).includes(n) || n.includes(norm(r.title))));
    manual.push({ name: `${name}${c.status === "inactive" ? " (inactive)" : ""}`, near });
  }

  if (done.length) {
    console.log(`already mapped (${done.length}):`);
    for (const d of done) console.log(`  ${d}`);
    console.log("");
  }

  console.log(`exact name match (${exact.length}):`);
  for (const e of exact) console.log(`  ${e.name.slice(0, 44).padEnd(46)} → ${e.slug}`);

  console.log(`\nneeds a person (${manual.length}):`);
  for (const m of manual) {
    console.log(`  ${m.name.slice(0, 44).padEnd(46)} → ?`);
    for (const n of m.near.slice(0, 3)) console.log(`      perhaps: ${n.slug}  (${n.title.slice(0, 40)})`);
  }

  // Explicit pairs always win, and are the only way anything inexact is set.
  const explicit: { name: string; slugs: string[] }[] = [];
  for (const pair of SETS) {
    const at = pair.lastIndexOf("=");
    if (at < 1) { console.error(`\n--set "${pair}" is not COURSE=slug[,slug]`); process.exit(1); }
    const name = pair.slice(0, at).trim();
    const slugs: string[] = [];
    for (const given of pair.slice(at + 1).split(",").map((v) => v.trim()).filter(Boolean)) {
      // A slug, or the title it belongs to — the listing prints both.
      const hit = remote.find((r) => r.slug === given) ?? remote.find((r) => norm(r.title) === norm(given));
      if (!hit) {
        console.error(`\nThe LMS has no course "${given}" — neither a slug nor a title. Nothing was changed.`);
        console.error("Its courses are:");
        for (const r of remote) console.error(`  ${r.slug.padEnd(42)} ${r.title}`);
        process.exit(1);
      }
      if (hit.slug !== given) console.log(`  read "${given}" as ${hit.slug}`);
      if (!slugs.includes(hit.slug)) slugs.push(hit.slug);
    }
    if (!slugs.length) { console.error(`\n--set "${pair}" names no LMS course`); process.exit(1); }
    explicit.push({ name, slugs });
  }

  if (!APPLY) {
    console.log(`\nNothing was changed. --apply would set ${exact.length + explicit.length}.`);
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const e of exact) {
    await Course.updateOne({ _id: e.id }, { $set: { lmsCourseSlug: e.slug, lmsCourseSlugs: [e.slug] } });
    written++;
  }
  for (const e of explicit) {
    const r = await Course.updateOne({ name: e.name }, { $set: { lmsCourseSlug: e.slugs[0], lmsCourseSlugs: e.slugs } });
    if (r.matchedCount === 0) {
      console.error(`  no Draw course is named "${e.name}". They are:`);
      for (const c of courses) console.error(`    ${String(c.name)}`);
    } else {
      console.log(`  ${e.name} → ${e.slugs.join(" + ")}`);
      written++;
    }
  }
  console.log(`\nset ${written}.`);
  console.log("New enrolments carry the courses from now on.");

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
