/**
 * Checks the 3CX call sync and the Calls page end to end on a scratch database,
 * against a stand-in 3CX served from this process (token, call log pages,
 * users, recording download). Never the real 3CX.
 *
 *   - Case 1: sync — rows grouped into calls by call history id (a queue call
 *     credited to whoever answered), keyed so a second and third run store
 *     nothing twice, 3CX's pages followed past 500 rows, the 90-day first run,
 *     the 3-hour overlap after it; calls with numbers no lead has, and internal
 *     calls, are not kept;
 *   - Case 2: phone matching on the last 9 digits whatever the format, a lead
 *     with two numbers, a number on two leads (the taker's own lead first);
 *     extensions from 3CX by email — a typed one (or one there from before)
 *     wins, the Users screen marks a changed one manual, a call taken on an
 *     extension nobody had is linked once someone gets it;
 *   - Case 3: totals, the per-person table, filters (Dubai days, direction,
 *     result, person, search by name / number), sorting, paging, CSV export,
 *     and who sees what (salesperson, team leader, Sales Manager, Super Admin,
 *     a role without Calls); a lead's calls; old call_logs not listed, and the
 *     older 3CX routes still answering;
 *   - Case 4: recordings — a link only for whoever may see the call, played
 *     through the backend (ranges pass through); expired, forged and altered
 *     links refused; 3CX not connected; the lock;
 *   - Case 5: Test connection (as in Tetra Commission) — Super Admin only;
 *     every step, the newest rows of the last 24 hours, a recording opened,
 *     never the key; 3CX unreachable; not connected.
 *
 * Run by calls-check.sh. Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

/* ── The stand-in 3CX ────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;
const ROWS: Row[] = [];
const THREECX_USERS = [
  { Id: 1, Number: "111", EmailAddress: "sam@test.local" },   // Sam typed 101 himself: his stays
  { Id: 2, Number: "102", EmailAddress: "TIA@test.local" },   // Tia has none: she gets 102 (email case ignored)
  { Id: 3, Number: "199", EmailAddress: "una@test.local" },   // Una's 104 was there before the sync: it stays
  { Id: 4, Number: "103", EmailAddress: "late@test.local" },  // nobody in the CRM yet
];
const KEY = "stand-in-key";
const seen = { tokens: 0, logWindows: [] as { from: number; to: number; skip: number }[], recordings: [] as string[], other: [] as string[] };
const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6, 7, 8]); // "RIFF…"

const threecx = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (path === "/connect/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      seen.tokens++;
      if (form.get("client_secret") !== KEY || form.get("grant_type") !== "client_credentials") return new Response("no", { status: 401 });
      return Response.json({ access_token: "tok-1", expires_in: 3600 });
    }
    if (req.headers.get("authorization") !== "Bearer tok-1") return new Response("unauthorized", { status: 401 });
    const log = path.match(/^\/xapi\/v1\/ReportCallLogData\/Pbx\.GetCallLogData\(periodFrom=([^,]+),periodTo=([^,]+),/);
    if (log) {
      const from = Date.parse(log[1]!), to = Date.parse(log[2]!);
      const skip = Number(url.searchParams.get("$skip") ?? 0), top = Number(url.searchParams.get("$top") ?? 100);
      seen.logWindows.push({ from, to, skip });
      const inWindow = ROWS.filter((r) => { const t = Date.parse(String(r.StartTime)); return t >= from && t < to; })
        .sort((a, b) => String(a.StartTime).localeCompare(String(b.StartTime)));
      if (/StartTime desc/.test(url.searchParams.get("$orderby") ?? "")) inWindow.reverse();
      return Response.json({ value: inWindow.slice(skip, skip + top) });
    }
    if (path === "/xapi/v1/Defs") return Response.json({ value: [] }, { headers: { "x-3cx-version": "20.0.1" } });
    if (path.startsWith("/xapi/v1/Users")) {
      const skip = Number(url.searchParams.get("$skip") ?? 0), top = Number(url.searchParams.get("$top") ?? 100);
      return Response.json({ value: THREECX_USERS.slice(skip, skip + top) });
    }
    const rec = path.match(/^\/xapi\/v1\/Recordings\/Pbx\.DownloadRecording\(recId=(\d+)\)$/);
    if (rec) {
      seen.recordings.push(rec[1]!);
      const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d+)?$/);
      const headers = { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="rec-${rec[1]}.wav"`, "accept-ranges": "bytes" };
      if (range) {
        const a = Number(range[1]), b = Math.min(Number(range[2] ?? AUDIO.length - 1), AUDIO.length - 1);
        return new Response(AUDIO.slice(a, b + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${a}-${b}/${AUDIO.length}`, "content-length": String(b - a + 1) } });
      }
      return new Response(AUDIO, { headers: { ...headers, "content-length": String(AUDIO.length) } });
    }
    seen.other.push(path);
    return new Response("not here", { status: 404 });
  },
});
const THREECX = `http://127.0.0.1:${threecx.port}`;
const connect = () => Object.assign(process.env, { THREECX_URL: THREECX, THREECX_CLIENT_ID: "crm-check", THREECX_API_KEY: KEY });
const disconnect = () => { process.env.THREECX_URL = ""; process.env.THREECX_CLIENT_ID = ""; process.env.THREECX_API_KEY = ""; };

/* ── The app ─────────────────────────────────────────────────────────────── */

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "calls-check-jwt",
  JWT_REFRESH_SECRET: "calls-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
});
disconnect();

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { User } = await import("../src/models/User.js");
const { LeadCall } = await import("../src/models/LeadCall.js");
const { CallLog } = await import("../src/models/CallLog.js");
await LeadCall.init();
const { signAccessToken } = await import("../src/utils/jwt.js");
const { drawDateOf, drawDayStart, drawToday } = await import("../src/utils/drawTime.js");
const sync = await import("../src/services/callSyncService.js");
const { env } = await import("../src/config/env.js");

const express = (await import("express")).default;
const helmet = (await import("helmet")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use(helmet());
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

/* ── People, teams, leads ────────────────────────────────────────────────── */

const superRole = new Types.ObjectId(), salesRole = new Types.ObjectId(), reporterRole = new Types.ObjectId();
const noCallsRole = new Types.ObjectId(), noExportRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  // Saved before Calls had a row: the default (view + export) applies.
  { _id: salesRole, roleName: "Sales Staff", isSystemRole: false, permissions: { leads: { view: true, create: true, edit: true, delete: false, approve: false, export: false } } },
  { _id: reporterRole, roleName: "Reporter", isSystemRole: false, permissions: { leads: { view: true } } },
  { _id: noCallsRole, roleName: "No Calls", isSystemRole: false, permissions: { leads: { view: true }, calls: { view: false, create: false, edit: false, delete: false, approve: false, export: false } } },
  { _id: noExportRole, roleName: "No Export", isSystemRole: false, permissions: { leads: { view: true }, calls: { view: true, create: false, edit: false, delete: false, approve: false, export: false } } },
]);
const PASSWORD = "Check-Pass-123!";
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, role: Types.ObjectId, extra: Record<string, unknown> = {}) {
  const email = `${name.toLowerCase()}@test.local`;
  const u = await User.create({ name, email, password: PASSWORD, role, ...extra });
  ids[name] = u._id;
  tokens[name] = signAccessToken({ userId: String(u._id), email, roleId: String(role) });
}
await person("Admin", superRole);
await person("Tom", salesRole);                                           // leads team Alpha
await person("Sam", salesRole, { extension: "101", extensionSource: "manual" });
await person("Tia", salesRole);
await person("Una", salesRole, { extension: "104" });                     // typed before the sync existed (no source)
await person("Mia", salesRole);                                           // the Sales Manager
await person("Rex", noCallsRole);
await person("Pat", noExportRole);
await person("Ria", reporterRole);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Mia, excludedUsers: [] });

const alpha = new Types.ObjectId(), beta = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: alpha, name: "Alpha", leaders: [ids.Tom], members: [ids.Sam, ids.Tia], status: "active", inactiveMembers: [], absentToday: [], settings: {} },
  { _id: beta, name: "Beta", leaders: [], members: [ids.Una], status: "active", inactiveMembers: [], absentToday: [], settings: {} },
]);

const now = Date.now();
const H = 3_600_000, D = 24 * H;
const lead = (name: string, phone: string, assignedTo: Types.ObjectId | null, team: Types.ObjectId | null, createdAt: Date) =>
  ({ _id: new Types.ObjectId(), name, phone, assignedTo, team, reporter: ids.Admin, status: "assigned", createdAt, updatedAt: createdAt, notes: [], reminders: [], activityLogs: [] });
const L1 = lead("Lina Lead", "050 123 4567", ids.Sam!, alpha, new Date(now - 40 * D));
const L2 = lead("Omar Two", "0551112222 / +971 52 333 4444", ids.Una!, beta, new Date(now - 40 * D));
const L3 = lead("Rami Three", "+971 56 777 8888", ids.Tia!, alpha, new Date(now - 40 * D));
const DUP_OLD = lead("Dup Old", "0589990000", ids.Una!, beta, new Date(now - 60 * D));
const DUP_NEW = lead("Dup New", "+971589990000", null, null, new Date(now - 5 * D));
await db.collection("leads").insertMany([L1, L2, L3, DUP_OLD, DUP_NEW]);

/* ── 3CX's call log ──────────────────────────────────────────────────────── */

const iso = (ms: number) => new Date(ms).toISOString();
let hid = 1000;
/** One row; `call` joins rows of one call (its MainCallHistoryId). */
function row(at: number, o: Partial<Row> & { call?: string | null }): Row {
  const { call, ...rest } = o;
  return {
    ...(call === null ? {} : { MainCallHistoryId: call ?? `mch-${hid++}` }),
    CallId: 1, SegmentId: 1, Indent: 1, StartTime: iso(at),
    SourceDn: "", SourceCallerId: "", SourceDisplayName: "", DestinationDn: "", DestinationCallerId: "", DestinationDisplayName: "",
    Answered: false, TalkingDuration: "PT0S", RingingDuration: "PT5S", Reason: "", ...rest,
  };
}
const todayStart = drawDayStart(drawToday())!.getTime();
const T = {
  A: now - 2 * D, B: now - 2 * D + H, C: todayStart + 60_000, C2: todayStart - 60_000, D: now - 3 * D,
  G: now - 4 * D, H: now - 1 * D, I: now - 10 * D + 5 * H, J: now - 2 * H, K: now - 5 * H,
};
ROWS.push(
  // A: Sam rings Lina, answered, two rows of one call, two recordings.
  row(T.A, { call: "A", SourceDn: "101", SourceDisplayName: "Sam S", DestinationDn: "10002", DestinationCallerId: "+971501234567", Answered: true, TalkingDuration: "PT1M30S", RingingDuration: "PT8S", SrcRecId: 11 }),
  row(T.A + 1000, { call: "A", SourceDn: "101", DestinationCallerId: "+971501234567", Answered: true, TalkingDuration: "00:00:45", DstRecId: 12 }),
  // B: Omar's second number calls the sales queue; Tia (ext 102) answers on a row under it.
  row(T.B, { call: "B", SourceDn: "10000", SourceCallerId: "+971523334444", DestinationDn: "800", DestinationDisplayName: "Sales Queue", Answered: true, TalkingDuration: "PT2M" }),
  row(T.B + 2000, { call: "B", Indent: 2, SourceDn: "10000", SourceCallerId: "+971523334444", DestinationDn: "102", DestinationDisplayName: "Tia T", Answered: true, TalkingDuration: "PT2M" }),
  // C: Lina calls Sam a minute after midnight (Dubai) today; nobody answers.
  row(T.C, { SourceDn: "10000", SourceCallerId: "00971501234567", DestinationDn: "101", DestinationDisplayName: "Sam S", RingingDuration: "PT20S" }),
  // C2: Rami calls a minute before midnight yesterday; Tia talks 30s.
  row(T.C2, { SourceDn: "10000", SourceCallerId: "0567778888", DestinationDn: "102", DestinationDisplayName: "Tia T", Answered: true, TalkingDuration: "PT30S" }),
  // D: ext 103 (nobody in the CRM yet) rings Rami; no answer.
  row(T.D, { SourceDn: "103", SourceDisplayName: "Late L", DestinationDn: "10002", DestinationCallerId: "0567778888", RingingDuration: "PT25S" }),
  // E: a number no lead has — ignored.
  row(T.A + 5 * H, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: "+971500000000", Answered: true, TalkingDuration: "PT3M" }),
  // F: an internal call, extension to extension — ignored.
  row(T.A + 6 * H, { SourceDn: "101", DestinationDn: "102", Answered: true, TalkingDuration: "PT1M" }),
  // G: no call history id at all (stands alone, keyed by its contents): Una rings the number on two leads.
  row(T.G, { call: null, SourceDn: "104", SourceDisplayName: "Una U", DestinationDn: "10002", DestinationCallerId: "0589990000", Answered: true, TalkingDuration: "PT10S" }),
  // H: Sam rings the same number — neither lead is his, so the newer one.
  row(T.H, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: "+971589990000", RingingDuration: "PT30S" }),
);
// A busy day: 520 calls to numbers no lead has, and one with Omar 515th in the list (3CX's second page).
for (let k = 0; k < 520; k++) {
  ROWS.push(row(now - 10 * D + k * 60_000, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: `+97150${String(1000000 + k)}`, Answered: true, TalkingDuration: "PT1S" }));
}
ROWS.push(row(T.I, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: "0551112222", Answered: true, TalkingDuration: "PT5S" }));
// Older than 90 days: not read.
ROWS.push(row(now - 100 * D, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: "+971501234567", Answered: true, TalkingDuration: "PT9S" }));

/* ── Helpers ─────────────────────────────────────────────────────────────── */

type Body = { success?: boolean; message?: string; data?: any; pagination?: any };
async function call(method: string, path: string, who?: string, body?: unknown): Promise<{ status: number; body: Body; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body, headers: res.headers };
}
const list = (who: string, qs = "") => call("GET", `/calls/log?preset=30d${qs}`, who);
const byKey = async (k: string) => LeadCall.findOne({ key: `call:${k}` }).lean();

/* ── Case 1 ──────────────────────────────────────────────────────────────── */

section("Case 1 — the sync: grouping, keys, pages, the first 90 days and the overlap");
connect();
let s = await sync.syncCalls("check");
check("the first run succeeds", s.ok, s);
const firstFrom = Math.min(...seen.logWindows.map((w) => w.from));
check("…reading 90 days back, a day at a time", Math.abs(firstFrom - (now - 90 * D)) < 60_000 && s.windows >= 90 && s.windows <= 91, { windows: s.windows });
check("…following 3CX's pages past 500 rows", seen.logWindows.some((w) => w.skip === 500));
const total1 = await LeadCall.countDocuments();
check("eight calls with leads kept (A B C C2 D G H I; not E, F, the 520 unknown numbers, nor anything older than 90 days)", total1 === 8, total1);
const A = await byKey("A");
check("A: two rows → one call, talk = the longest row (90s), ring 8s, both recordings, Sam's extension",
  !!A && A.rows === 2 && A.talkSeconds === 90 && A.ringSeconds === 8 && A.recordingIds.join() === "11,12" && A.extension === "101" && A.direction === "out" && A.status === "answered", A);
check("…on Lina's lead, taken by Sam (his typed extension)", String(A?.lead) === String(L1._id) && String(A?.user) === String(ids.Sam) && A?.userName === "Sam");
const B = await byKey("B");
check("B: a queue call is Tia's — who answered under the queue's row", B?.extension === "102" && String(B?.user) === String(ids.Tia) && B?.direction === "in" && B?.talkSeconds === 120, B);
check("…matched by Omar's second number", String(B?.lead) === String(L2._id) && B?.numberKey === "523334444");
const C = await LeadCall.findOne({ startedAt: new Date(T.C) }).lean();
check("C: Lina called, nobody answered — missed, on '00971…' matched to '050 123 4567'", C?.status === "missed" && String(C?.lead) === String(L1._id) && C?.ringSeconds === 20, C);
const Dcall = await LeadCall.findOne({ startedAt: new Date(T.D) }).lean();
check("D: we called, no answer — not answered, ext 103 with nobody linked yet", Dcall?.status === "no_answer" && Dcall?.extension === "103" && Dcall?.user === null && Dcall?.agentName === "Late L", Dcall);
const G = await LeadCall.findOne({ startedAt: new Date(T.G) }).lean();
check("G: no call history id — kept under a key of its own contents", !!G && /^h:[0-9a-f]{40}$/.test(G.key), G?.key);
check("…a number on two leads: Una's own lead (Dup Old), not the newer one", String(G?.lead) === String(DUP_OLD._id));
const Hc = await LeadCall.findOne({ startedAt: new Date(T.H) }).lean();
check("H: Sam rings that number — neither is his, so the newest lead (Dup New)", String(Hc?.lead) === String(DUP_NEW._id));
const I = await LeadCall.findOne({ startedAt: new Date(T.I) }).lean();
check("I: 515th row of a busy day (3CX's second page) — kept", String(I?.lead) === String(L2._id) && I?.talkSeconds === 5);
check("no internal or unknown-number call kept", (await LeadCall.countDocuments({ numberKey: { $in: ["500000000", ""] } })) === 0);
const syncedTo = new Date((await sync.getCallSettings()).syncedTo!).getTime();

seen.logWindows = [];
s = await sync.syncCalls("check");
check("a second run straight after: nothing new, nothing doubled", s.ok && s.inserted === 0 && (await LeadCall.countDocuments()) === total1, s);
const secondFrom = Math.min(...seen.logWindows.map((w) => w.from));
check("…reading from 3 hours before where the last one got to", Math.abs(secondFrom - (syncedTo - sync.OVERLAP_MS)) < 5_000, { secondFrom, syncedTo });

// J ended inside the overlap (logged late), K before it.
ROWS.push(row(T.J, { call: "J", SourceDn: "10000", SourceCallerId: "+971501234567", DestinationDn: "101", DestinationDisplayName: "Sam S", Answered: true, TalkingDuration: "PT1M" }));
ROWS.push(row(T.K, { call: "K", SourceDn: "10000", SourceCallerId: "+971501234567", DestinationDn: "101", Answered: true, TalkingDuration: "PT1M" }));
s = await sync.syncCalls("check");
check("a call logged late, inside the overlap, is picked up (J)", s.inserted === 1 && !!(await byKey("J")), s);
check("…one before the overlap is not (K)", !(await byKey("K")));
await LeadCall.deleteOne({ key: "call:K" });
ROWS.splice(ROWS.findIndex((r) => r.MainCallHistoryId === "K"), 1);
s = await sync.syncCalls("check");
check("a third run: still nothing doubled", s.inserted === 0 && (await LeadCall.countDocuments()) === total1 + 1, s);
check("keys are unique in the database", (await LeadCall.collection.indexes()).some((i) => i.key?.key === 1 && i.unique));

/* ── Case 2 ──────────────────────────────────────────────────────────────── */

section("Case 2 — extensions from 3CX by email; typed ones win");
const ext = async (n: string) => User.findById(ids[n]).select("extension extensionSource").lean();
check("Tia had none: 102 from 3CX (email case ignored), marked 3cx", (await ext("Tia"))?.extension === "102" && (await ext("Tia"))?.extensionSource === "3cx");
check("Sam typed 101: kept, though 3CX says 111", (await ext("Sam"))?.extension === "101");
check("Una's 104 from before the sync (no source): kept, though 3CX says 199", (await ext("Una"))?.extension === "104");
let r = await call("PUT", `/users/${ids.Una}`, "Admin", { name: "Una", extension: "104" });
check("saving Una on the Users screen without changing it leaves its source alone", r.status === 200 && (await ext("Una"))?.extensionSource == null, r.body.message);
r = await call("PUT", `/users/${ids.Tia}`, "Admin", { extension: "122" });
check("a super admin types 122 for Tia: marked manual", r.status === 200 && (await ext("Tia"))?.extension === "122" && (await ext("Tia"))?.extensionSource === "manual", r.body.message);
await sync.syncExtensions();
check("…and 3CX's 102 no longer overwrites it", (await ext("Tia"))?.extension === "122");
await db.collection("app_settings").updateOne({ _id: "threecx_calls" as any }, { $set: { syncedTo: new Date(T.B - H) } });
s = await sync.syncCalls("check");
const B2 = await byKey("B");
check("calls read again while their extension is nobody's keep who took them (B stays Tia's), nothing doubled",
  s.ok && String(B2?.user) === String(ids.Tia) && (await LeadCall.countDocuments()) === total1 + 1, { s, user: B2?.user });
r = await call("PUT", `/users/${ids.Tia}`, "Admin", { extension: "" });
check("cleared: no longer manual", (await ext("Tia"))?.extensionSource == null);
await sync.syncExtensions();
check("…so 3CX fills it again", (await ext("Tia"))?.extension === "102" && (await ext("Tia"))?.extensionSource === "3cx");
await person("Late", salesRole);
const ex = await sync.syncExtensions();
check("a new user with 3CX's email gets ext 103", (await ext("Late"))?.extension === "103", ex);
await sync.syncCalls("check");
const D2 = await LeadCall.findOne({ startedAt: new Date(T.D) }).lean();
check("…and the call ext 103 made before is now theirs", String(D2?.user) === String(ids.Late) && D2?.userName === "Late");

/* ── Case 3 ──────────────────────────────────────────────────────────────── */

section("Case 3 — totals, filters, sorting, who sees what");
r = await list("Admin");
const st = r.body.data?.stats;
check("Super Admin, 30 days: 9 calls", r.status === 200 && st?.total === 9 && r.body.data.calls.length === 9, st);
check("…4 incoming, 5 outgoing", st?.incoming === 4 && st?.outgoing === 5, st);
check("…6 connected, 1 missed, 2 not answered", st?.connected === 6 && st?.missed === 1 && st?.notAnswered === 2, st);
check("…315s talking, 53s average connected call, 1 recorded", st?.talkSeconds === 315 && st?.averageTalkSeconds === 53 && st?.recorded === 1, st);
check("…newest first", r.body.data.calls.every((c: any, i: number, a: any[]) => !i || a[i - 1].startedAt >= c.startedAt));
const sam = r.body.data.people.find((p: any) => p.userId === String(ids.Sam));
check("per person: Sam 5 calls, 3 connected, 1 missed, 1 not answered, 155s, 52s average",
  sam?.total === 5 && sam?.connected === 3 && sam?.missed === 1 && sam?.notAnswered === 1 && sam?.talkSeconds === 155 && sam?.averageTalkSeconds === 52, sam);
check("…Tia, Una and Late too", ["Tia", "Una", "Late"].every((n) => r.body.data.people.some((p: any) => p.userId === String(ids[n]))));
check("a row carries the lead (live name + phone), who took it, and how many recordings",
  r.body.data.calls.some((c: any) => c.leadName === "Lina Lead" && c.leadPhone === "050 123 4567" && c.userName === "Sam" && c.recordings === 2));
check("old call_logs are not listed", (await CallLog.create({ leadId: L1._id, phoneNumber: "0501234567", callType: "Outbound", callDirection: "outbound", callDate: new Date(), source: "click_to_call" })) && (await list("Admin")).body.data.stats.total === 9);

const totalOf = async (qs: string, who = "Admin") => (await list(who, qs)).body.data?.stats?.total;
check("direction in → 4, out → 5", (await totalOf("&direction=in")) === 4 && (await totalOf("&direction=out")) === 5);
check("result connected → 6, missed → 1, not answered → 2", (await totalOf("&result=connected")) === 6 && (await totalOf("&result=missed")) === 1 && (await totalOf("&result=not_answered")) === 2);
r = await list("Admin", `&person=u:${ids.Sam}`);
check("person Sam → 5 listed and counted; the table still lists everyone", r.body.data.stats.total === 5 && r.body.data.calls.length === 5 && r.body.data.people.length >= 4, r.body.data.stats);
check("search 'lina' → her 3 calls", (await totalOf("&search=lina")) === 3);
check("search '052 333 4444' (a number, any format) → 1", (await totalOf(`&search=${encodeURIComponent("052 333 4444")}`)) === 1);
const fixture = [T.A, T.B, T.C, T.C2, T.D, T.G, T.H, T.I, T.J];
const today = drawToday(), yesterday = drawDateOf(new Date(todayStart - 1));
r = await call("GET", "/calls/log?preset=today", "Admin");
check("Today (Dubai): from midnight Dubai, so C (00:01) is in and C2 (23:59 yesterday) is not",
  r.body.data.stats.total === fixture.filter((t) => drawDateOf(new Date(t)) === today).length && r.body.data.calls.some((c: any) => c.startedAt === iso(T.C)) && !r.body.data.calls.some((c: any) => c.startedAt === iso(T.C2)), r.body.data.period);
r = await call("GET", `/calls/log?from=${yesterday}&to=${yesterday}`, "Admin");
check("a custom day (yesterday): C2 in, C not", r.body.data.calls.some((c: any) => c.startedAt === iso(T.C2)) && !r.body.data.calls.some((c: any) => c.startedAt === iso(T.C))
  && r.body.data.stats.total === fixture.filter((t) => drawDateOf(new Date(t)) === yesterday).length);
check("7 days by default", (await call("GET", "/calls/log", "Admin")).body.data.stats.total === fixture.filter((t) => t >= drawDayStart(drawDateOf(new Date(now - 6 * D)))!.getTime()).length);
check("This month: from the 1st (Dubai)", (await call("GET", "/calls/log?preset=month", "Admin")).body.data.period.from === `${today.slice(0, 7)}-01`);
r = await list("Admin", "&sort=talk&order=desc");
check("sort by talk, longest first (B 120s)", r.body.data.calls[0].talkSeconds === 120 && r.body.data.calls.every((c: any, i: number, a: any[]) => !i || a[i - 1].talkSeconds >= c.talkSeconds));
r = await list("Admin", "&sort=ring&order=asc");
check("sort by ring, shortest first", r.body.data.calls.every((c: any, i: number, a: any[]) => !i || a[i - 1].ringSeconds <= c.ringSeconds));
r = await list("Admin", "&sort=date&order=asc");
check("sort by date, oldest first", r.body.data.calls[0].startedAt === iso(T.I));
r = await list("Admin", "&limit=2&page=2");
check("paged: 2 a page, page 2 of 5, totals still over all 9", r.body.data.calls.length === 2 && r.body.data.pagination.totalPages === 5 && r.body.data.pagination.page === 2 && r.body.data.stats.total === 9, r.body.data.pagination);
r = await list("Admin", "&export=1&limit=5000");
check("CSV export: every row in one go", r.status === 200 && r.body.data.calls.length === 9);
r = await list("Pat", "&export=1&limit=5000");
check("…refused without Export on Calls (403)", r.status === 403, r.status);
check("…but Pat may still view", (await list("Pat")).status === 200);

const sees = async (who: string) => (await list(who)).body.data?.stats?.total;
check("Sam (salesperson): his own calls + every call on his leads = 5", (await sees("Sam")) === 5, await sees("Sam"));
check("Tom (team leader of Alpha): his team's calls + Alpha's leads = 8", (await sees("Tom")) === 8, await sees("Tom"));
check("Una (Beta): her call + calls on her leads = 3", (await sees("Una")) === 3, await sees("Una"));
check("Mia (the Sales Manager): everyone = 9", (await sees("Mia")) === 9);
check("Ria (Reporter, sees every lead): everyone = 9", (await sees("Ria")) === 9);
check("a role saved before Calls existed gets it by default (Sam: 200)", (await list("Sam")).status === 200);
check("a role with Calls unticked: 403", (await list("Rex")).status === 403);
check("no sign-in: 401", (await call("GET", "/calls/log")).status === 401);
r = await list("Sam");
check("Sam's 3CX note: connected, updated, first import done, no error shown to him",
  r.body.data.threecx.connected === true && !!r.body.data.threecx.updatedAt && r.body.data.threecx.firstImportDone === true && r.body.data.threecx.error === null && r.body.data.canSync === false);

const leadCalls = async (who: string, l: { _id: Types.ObjectId }) => (await call("GET", `/calls/log/lead/${l._id}`, who)).body.data;
check("a lead's calls: Sam on Lina (his) → all 3", (await leadCalls("Sam", L1))?.stats?.total === 3);
check("…Sam on Omar (Una's) → only the call he made himself (I)", (await leadCalls("Sam", L2))?.calls?.map((c: any) => c.startedAt).join() === iso(T.I));
check("…Una on Lina → none", (await leadCalls("Una", L1))?.stats?.total === 0);
check("…Admin on Rami → C2 and D, all time", (await leadCalls("Admin", L3))?.stats?.total === 2);
check("…an unknown lead → 404", (await call("GET", `/calls/log/lead/${new Types.ObjectId()}`, "Admin")).status === 404 && (await call("GET", "/calls/log/lead/nope", "Admin")).status === 404);

check("the older 3CX routes still answer: template", (await fetch(`http://127.0.0.1:${port}/api/v1/calls/3cx-template`)).status === 200);
r = await call("GET", "/calls/recent", "Admin");
check("…recent call_logs", r.status === 200 && r.body.data.calls.length === 1);
r = await call("GET", `/calls/lead/${L1._id}`, "Admin");
check("…a lead's call_logs", r.status === 200 && r.body.data.source === "local");

/* ── Case 4 ──────────────────────────────────────────────────────────────── */

section("Case 4 — recordings, 3CX not connected, the lock");
r = await call("GET", `/calls/log/${A!._id}/recording-link`, "Una");
check("Una may not open Sam's call on Sam's lead (403)", r.status === 403, r.status);
r = await call("GET", `/calls/log/${A!._id}/recording-link`, "Sam");
check("Sam gets a 10-minute link", r.status === 200 && r.body.data.url.startsWith("/api/v1/calls/log/recording?") && r.body.data.expiresIn === 600, r.body);
const link = String(r.body.data.url);
check("…that holds no 3CX key", !link.includes(KEY) && !link.includes("tok-1"));
let audio = await fetch(`http://127.0.0.1:${port}${link}`);
let bytes = new Uint8Array(await audio.arrayBuffer());
check("…plays through the backend: audio/wav, the recording's bytes", audio.status === 200 && audio.headers.get("content-type") === "audio/wav" && bytes.length === AUDIO.length && seen.recordings.at(-1) === "11");
check("…playable from the web app's origin (not helmet's same-origin)", audio.headers.get("cross-origin-resource-policy") === "cross-origin");
audio = await fetch(`http://127.0.0.1:${port}${link}`, { headers: { range: "bytes=0-3" } });
check("…ranges pass through (206, bytes 0-3)", audio.status === 206 && audio.headers.get("content-range") === `bytes 0-3/${AUDIO.length}` && (await audio.arrayBuffer()).byteLength === 4);
r = await call("GET", `/calls/log/${A!._id}/recording-link?index=1`, "Tom");
audio = await fetch(`http://127.0.0.1:${port}${r.body.data?.url}`);
check("part 2 for Tom (his team): the second recording", audio.status === 200 && seen.recordings.at(-1) === "12");
check("a call without a recording: 404", (await call("GET", `/calls/log/${Dcall!._id}/recording-link`, "Admin")).status === 404);
check("an unknown call: 404", (await call("GET", `/calls/log/${new Types.ObjectId()}/recording-link`, "Admin")).status === 404);
const expired = sync.recordingPath(String(A!._id), 0, String(ids.Sam), Date.now() - 11 * 60_000);
check("an expired link: 403", (await fetch(`http://127.0.0.1:${port}${expired}`)).status === 403);
const forged = link.replace(/s=[^&]+/, "s=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
check("a forged signature: 403", (await fetch(`http://127.0.0.1:${port}${forged}`)).status === 403);
const other = link.replace(/c=[a-f0-9]{24}/, `c=${String(Dcall!._id)}`);
check("the same signature on another call: 403", (await fetch(`http://127.0.0.1:${port}${other}`)).status === 403);
const later = link.replace(/e=(\d+)/, (_m, e) => `e=${Number(e) + 3600}`);
check("a link stretched to last longer: 403", (await fetch(`http://127.0.0.1:${port}${later}`)).status === 403);
check("…and someone else's name on it: 403", (await fetch(`http://127.0.0.1:${port}${link.replace(/u=[a-f0-9]{24}/, `u=${ids.Una}`)}`)).status === 403);
check("…or no signature: 403", (await fetch(`http://127.0.0.1:${port}/api/v1/calls/log/recording?c=${A!._id}&i=0`)).status === 403);

r = await call("POST", "/calls/log/sync", "Sam");
check("Sync now: Super Admin only (403 for Sam)", r.status === 403);
r = await call("POST", "/calls/log/sync", "Admin");
check("…Super Admin: runs, up to date", r.status === 200 && r.body.data?.inserted === 0, r.body);

disconnect();
s = await sync.syncCalls("check");
check("3CX not connected: the sync does nothing and says so", !s.ok && s.skipped === "3CX is not connected", s);
r = await list("Admin");
check("…the Calls page still lists what it has, and says 3CX is not connected", r.body.data.threecx.connected === false && r.body.data.stats.total === 9);
check("…Sync now: 400", (await call("POST", "/calls/log/sync", "Admin")).status === 400);
const logs: string[] = [];
const keep = console.log;
console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
sync.startCallSyncWorker();
(env as { RUN_SCHEDULERS: boolean }).RUN_SCHEDULERS = true;
sync.startCallSyncWorker();
(env as { RUN_SCHEDULERS: boolean }).RUN_SCHEDULERS = false;
console.log = keep;
check("the worker: off with RUN_SCHEDULERS=false, then off for 3CX not connected — each with a line", /RUN_SCHEDULERS is off/.test(logs[0] ?? "") && /3CX not connected/.test(logs[1] ?? ""), logs);
const before = seen.tokens;
const playing = await fetch(`http://127.0.0.1:${port}${(await (async () => { connect(); const x = await call("GET", `/calls/log/${A!._id}/recording-link`, "Sam"); disconnect(); return x; })()).body.data.url}`);
check("…a recording while not connected: 502, and nothing is asked of 3CX", playing.status === 502 && seen.tokens === before);
connect();

check("the lock: taken once", await sync.takeLock());
check("…not twice", !(await sync.takeLock()));
s = await sync.syncCalls("check");
check("…a sync while it is held is skipped", !s.ok && s.skipped === "A sync is already running", s);
await db.collection("app_settings").updateOne({ _id: "threecx_calls" as any }, { $set: { lockUntil: new Date(Date.now() - 1000) } });
check("…a lock left behind expires (15 minutes) and can be taken", await sync.takeLock());
await sync.releaseLock();
const both = await Promise.all([sync.syncCalls("one"), sync.syncCalls("two")]);
check("two syncs at once: one runs, the other is skipped", both.filter((x) => x.ok).length === 1 && both.filter((x) => x.skipped === "A sync is already running").length === 1, both);
check("…and still nothing doubled", (await LeadCall.countDocuments()) === total1 + 1);
section("Case 5 — Test connection, as in Tetra Commission");
// Half an hour ago: Sam rings Lina, answered, recorded — and 250 calls to nobody's numbers before it, more than the test reads.
for (let k = 0; k < 250; k++) ROWS.push(row(now - 20 * H + k * 60_000, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: `+97155${String(1000000 + k)}`, Answered: true, TalkingDuration: "PT1S" }));
ROWS.push(row(now - 30 * 60_000, { call: "TEST", SourceDn: "101", SourceDisplayName: "Sam S", DestinationDn: "10002", DestinationCallerId: "+971501234567", Answered: true, TalkingDuration: "PT40S", SrcRecId: 21 }));
r = await call("POST", "/calls/log/test", "Sam");
check("Super Admin only (403 for Sam)", r.status === 403);
r = await call("POST", "/calls/log/test", "Admin");
const t = r.body.data;
check("every step, in order, all passed", r.status === 200 && t?.ok === true
  && (t.steps ?? []).map((x: { name: string }) => x.name).join(",") === "Settings,Sign in,Extensions,Call log,Recordings", t?.steps);
check("…settings show the address and client, never the key", t?.steps?.[0]?.detail?.includes(THREECX) && t.steps[0].detail.includes("crm-check") && !JSON.stringify(r.body).includes(KEY));
check("…signed in, with 3CX's version", /Connected — 3CX 20\.0\.1/.test(t?.steps?.[1]?.detail ?? ""), t?.steps?.[1]);
check("…3CX's users matched by email", /3CX users; \d+ matched to CRM users by email/.test(t?.steps?.[2]?.detail ?? ""), t?.steps?.[2]);
check("…the newest 200 rows of the last 24 hours, with Sam's call to Lina in them", /200 rows in the last 24 hours/.test(t?.steps?.[3]?.detail ?? "")
  && (t.parsed ?? []).some((c: { lead: string | null }) => c.lead === "Lina Lead"), t?.steps?.[3]);
check("…its recording opened (asked of 3CX with a range)", /A recording opened/.test(t?.steps?.[4]?.detail ?? "") && seen.recordings.at(-1) === "21", t?.steps?.[4]);
check("…and a few rows as 3CX sends them", Array.isArray(t?.sample) && t.sample.length === 3);
process.env.THREECX_URL = "http://127.0.0.1:9";
r = await call("POST", "/calls/log/test", "Admin");
check("3CX unreachable: it stops at Sign in and says why", r.status === 200 && r.body.data?.ok === false && r.body.data.steps.at(-1)?.name === "Sign in"
  && /reach 3CX|did not answer/.test(r.body.data.steps.at(-1)?.detail ?? ""), r.body.data?.steps);
disconnect();
r = await call("POST", "/calls/log/test", "Admin");
check("not connected: one failed step, saying what to set", r.body.data?.ok === false && r.body.data.steps.length === 1 && /THREECX_API_KEY/.test(r.body.data.steps[0].detail));
connect();

check("the stand-in 3CX was asked nothing it doesn't serve", seen.other.length === 0, seen.other);

/* ── Done ────────────────────────────────────────────────────────────────── */

server.close();
threecx.stop(true);
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
