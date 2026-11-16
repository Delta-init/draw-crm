/**
 * Checks the WhatsApp integration (the user, 2026-10-27: "the CS Portal's WhatsApp — we need it here also"),
 * on a scratch database, through the API, with a stand-in for WhatsApp (a real phone can't be linked here):
 *
 *   - Case 1: linking — off in a process that doesn't run the timed jobs; who may link; who is listed for whom.
 *   - Case 2: a message comes in — kept under its owner, matched to the lead by its number's last 9 digits; a
 *     replayed one is one; a number no lead has is a chat with no lead; one sent from the phone is kept as theirs.
 *   - Case 3: unread — counted, the new ones since the last ask, and read by its owner only.
 *   - Case 4: sending — from your own linked WhatsApp only, to a number on WhatsApp; kept, matched to the lead.
 *   - Case 5: who reads whose chats — the owner; their team leader; the Sales Manager; nobody else.
 *   - Case 6: a chat that is no lead's — linked to a lead you may see (later messages follow), or made a lead.
 *   - Case 7: the lead page's card — the lead's chats you may read, and its numbers.
 *   - Case 8: photos and files, voice notes — kept on disk, on short-lived signed links.
 *   - Case 9: no WhatsApp access — refused.
 *   - Case 10: one WhatsApp, two people (2026-11-16) — a Super Admin shares Sam's with Omar: Omar sends from it (named
 *     on each message), can't link or unlink it; each sees, counts unread of, is told of and sends in only his own
 *     leads' chats (a lead moved takes its chat; a number started from the CRM is the starter's); New chat — his own
 *     lead or a number, another's refused saying whose; the team leader, Sales Manager and Super Admin see as before;
 *     taken off, back to his own.
 *
 * Run by whatsapp-check.sh. Scratch database only.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);

const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), "wa-media-"));
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "whatsapp-check-jwt", JWT_REFRESH_SECRET: "whatsapp-check-refresh", NODE_ENV: "test",
  RUN_SCHEDULERS: "false", WHATSAPP_MEDIA_DIR: MEDIA, WHATSAPP_SESSION_DIR: path.join(MEDIA, "sessions"),
  R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { signAccessToken } = await import("../src/utils/jwt.js");
const wa = await import("../src/services/whatsapp/service.js");
const { WhatsAppMessage } = await import("../src/models/WhatsAppMessage.js");

/* ── People: a team (Lina leads Sam and Sally), Omar elsewhere, Mona the Sales Manager, Nora without WhatsApp ── */
const perms = (wa: boolean) => ({
  leads: { view: true, create: true, edit: true, delete: false, approve: false, export: false },
  // Without it the role would get WhatsApp's open default: switched off, as a role someone unticked.
  whatsapp: { view: wa, create: wa, edit: false, delete: false, approve: false, export: false },
});
const superRole = new Types.ObjectId(), salesRole = new Types.ObjectId(), noWaRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: salesRole, roleName: "Sales Staff", isSystemRole: false, permissions: perms(true) },
  { _id: noWaRole, roleName: "No WhatsApp", isSystemRole: false, permissions: perms(false) },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Root", superRole], ["Lina", salesRole], ["Sam", salesRole], ["Sally", salesRole], ["Omar", salesRole], ["Mona", salesRole], ["Nora", noWaRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const P = (n: string) => people[n]!.id;
const titans = new Types.ObjectId(), others = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: titans, name: "Titans", status: "active", leaders: [P("Lina")], members: [P("Sam"), P("Sally")] },
  { _id: others, name: "Others", status: "active", leaders: [], members: [P("Omar")] },
]);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: P("Mona"), excludedUsers: [] });

/* ── Leads ── */
const lead = async (name: string, phone: string, owner: string, team: Types.ObjectId) => {
  const id = new Types.ObjectId();
  await db.collection("leads").insertOne({ _id: id, name, phone, assignedTo: P(owner), team, reporter: P(owner), status: "assigned", createdAt: new Date(), updatedAt: new Date() });
  return String(id);
};
const asha = await lead("Asha Thomas", "+971 50 123 4567", "Sam", titans);
const omarLead = await lead("Bilal Khan", "0559876543", "Omar", others);

/* ── A stand-in WhatsApp ── */
type Sent = { jid: string; content: Record<string, unknown> };
function fakeSock(sent: Sent[]) {
  let n = 0;
  return {
    sendMessage: async (jid: string, content: Record<string, unknown>) => { sent.push({ jid, content }); return { key: { id: `SENT-${++n}-${Date.now()}` } }; },
    onWhatsApp: async (phone: string) => [{ exists: !phone.endsWith("0000"), jid: `${phone}@s.whatsapp.net` }],
    updateMediaMessage: async () => undefined,
    user: { id: "971500000001:1@s.whatsapp.net" },
  } as never;
}
const samSent: Sent[] = [];
const incoming = (owner: string, from: string, body: string, opts: { id?: string; fromMe?: boolean; name?: string } = {}) =>
  wa.receive({ id: String(P(owner)), name: owner }, fakeSock([]), {
    key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: !!opts.fromMe, id: opts.id ?? `IN-${Math.random().toString(36).slice(2)}` },
    message: { conversation: body }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: opts.name ?? "",
  } as never);

/* ── The API ── */
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const token = (name: string) => signAccessToken({ userId: String(people[name]!.id), email: `${name.toLowerCase()}@test.local`, roleId: String(people[name]!.role) });
type Answer = { status: number; body: { data?: any; message?: string } };
async function call(method: string, p: string, who: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token(who)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}
async function form(p: string, who: string, fields: Record<string, string>, file: { name: string; type: string; bytes: Uint8Array }): Promise<Answer> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([file.bytes], { type: file.type }), file.name);
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, { method: "POST", headers: { authorization: `Bearer ${token(who)}` }, body: fd });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}
const chatsOf = async (who: string, owner = "") => (await call("GET", `/whatsapp/chats${owner ? `?ownerId=${P(owner)}` : ""}`, who));

try {
  section("Case 1 — linking");
  let r = await call("GET", "/whatsapp/status", "Sam");
  check("Sam: not linked, may link, lists nobody else (only his own chats)", r.status === 200 && r.body.data?.me?.status === "disconnected" && r.body.data?.canLink === true && r.body.data?.owners?.length === 0, j(r.body));
  check("…switched off in a process that doesn't run the timed jobs", r.body.data?.enabled === false);
  r = await call("POST", "/whatsapp/connect", "Sam");
  check("…so linking is refused here, saying so", r.status === 503 && /switched off/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("GET", "/whatsapp/status", "Lina");
  const linaSees = (r.body.data?.owners ?? []).map((o: any) => o.name).sort();
  check("Lina (team leader): lists her team — herself, Sam and Sally — not Omar", j(linaSees) === j(["Lina", "Sally", "Sam"]), j(linaSees));
  r = await call("GET", "/whatsapp/status", "Mona");
  check("Mona (Sales Manager): lists everyone", (r.body.data?.owners ?? []).length === 7, j((r.body.data?.owners ?? []).map((o: any) => o.name)));

  section("Case 2 — a message comes in");
  await incoming("Sam", "971501234567", "Hi, about the course", { id: "IN-1", name: "Asha" });
  await incoming("Sam", "971501234567", "Hi, about the course", { id: "IN-1", name: "Asha" });
  let c = await chatsOf("Sam");
  const ashaChat = c.body.data?.chats?.find((x: any) => x.chat === "971501234567");
  check("kept under Sam, matched to the lead by its last 9 digits (the record says +971 50 123 4567)", ashaChat?.lead?.id === asha && ashaChat.name === "Asha Thomas" && ashaChat.unread === 1, j(ashaChat));
  check("…the same WhatsApp message twice (a reconnect replays them) is one", ashaChat?.count === 1, j(ashaChat));
  await incoming("Sam", "971522222222", "Hello? price?", { name: "Stranger" });
  c = await chatsOf("Sam");
  const stranger = c.body.data?.chats?.find((x: any) => x.chat === "971522222222");
  check("a number no lead has: a chat with no lead, named as on WhatsApp", stranger?.lead === null && stranger.name === "Stranger" && stranger.whatsappName === "Stranger", j(stranger));
  await incoming("Sam", "971501234567", "Sure, sending details", { fromMe: true });
  c = await chatsOf("Sam");
  check("one sent from his phone is kept, as his, already read", c.body.data?.chats?.find((x: any) => x.chat === "971501234567")?.last?.direction === "out"
    && (await WhatsAppMessage.findOne({ body: "Sure, sending details" }).lean())?.sentByName === "From their phone");

  section("Case 3 — unread");
  const before = new Date(Date.now() - 1000).toISOString();
  r = await call("GET", `/whatsapp/unread?since=${encodeURIComponent(before)}`, "Sam");
  check("Sam has 2 unread, and the new ones since he last asked", r.body.data?.unread === 2 && r.body.data?.messages?.length === 2 && r.body.data.messages.some((m: any) => m.name === "Asha Thomas"), j(r.body.data));
  r = await call("POST", "/whatsapp/read", "Lina", { chat: "971501234567" });
  check("Lina reading it leaves it unread for Sam", r.status === 200 && (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread === 2);
  r = await call("POST", "/whatsapp/read", "Sam", { chat: "971501234567" });
  check("Sam opening it reads it", r.body.data?.marked === 1 && (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread === 1);

  section("Case 4 — sending");
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "0501234567", text: "Welcome!" });
  check("not linked: refused, saying where to link", r.status === 409 && /not linked/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  wa.attachSocketForCheck(String(P("Sam")), fakeSock(samSent), "971500000001");
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "0501234567", text: "Welcome!" });
  const out = await WhatsAppMessage.findOne({ body: "Welcome!" }).lean();
  check("linked: sent from his WhatsApp to the number with its country code, kept under the lead's chat", r.status === 200 && r.body.data?.chat === "971501234567"
    && samSent.at(-1)?.jid === "971501234567@s.whatsapp.net" && String(out?.lead) === asha && out?.sentByName === "Sam", `${r.status} ${r.body.message} ${j(out)}`);
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "971500000000", text: "x" });
  check("a number not on WhatsApp: refused", r.status === 400 && /not on WhatsApp/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", "/whatsapp/send", "Sally", { chat: "971501234567", text: "x" });
  check("Sally isn't linked: she can't send from Sam's", r.status === 409, `${r.status}`);

  section("Case 5 — who reads whose chats");
  r = await chatsOf("Lina", "Sam");
  check("Lina (his team leader) reads Sam's — read only", r.status === 200 && r.body.data?.chats?.length === 2 && r.body.data?.canSend === false, `${r.status} ${j(r.body.data?.canSend)}`);
  check("Mona (Sales Manager) reads Sam's", (await chatsOf("Mona", "Sam")).status === 200);
  check("Root (Super Admin) reads Sam's", (await chatsOf("Root", "Sam")).status === 200);
  r = await chatsOf("Omar", "Sam");
  check("Omar (another team) doesn't", r.status === 403, `${r.status}`);
  check("…nor Sally Lina's (a team member doesn't read her leader's)", (await chatsOf("Sally", "Lina")).status === 403);
  r = await call("GET", `/whatsapp/messages?ownerId=${P("Sam")}&chat=971501234567`, "Lina");
  check("the chat's messages, oldest first, for Lina", r.status === 200 && r.body.data?.messages?.length === 3 && r.body.data.messages[0].body === "Hi, about the course", j(r.body.data?.messages?.map((m: any) => m.body)));

  section("Case 6 — a chat that is no lead's");
  r = await call("POST", "/whatsapp/link", "Sam", { chat: "971522222222", leadId: omarLead });
  check("Sam can't link it to Omar's lead (not his to see)", r.status === 403, `${r.status} ${r.body.message}`);
  r = await call("GET", "/whatsapp/lead-options?search=asha", "Sam");
  check("the leads he may link to, by name", r.status === 200 && r.body.data?.length === 1 && r.body.data[0].id === asha, j(r.body.data));
  r = await call("GET", "/whatsapp/lead-options?search=055 987 6543", "Sam");
  check("…Omar's lead isn't among them, typed as a number", r.status === 200 && r.body.data?.length === 0, j(r.body.data));
  r = await call("GET", "/whatsapp/lead-options?search=055 987 6543", "Mona");
  check("…for Mona it is (spaces and all)", r.body.data?.[0]?.id === omarLead, j(r.body.data));
  r = await call("POST", "/whatsapp/link", "Sam", { chat: "971522222222", leadId: asha });
  check("linked to Asha's lead: the chat shows under her", r.status === 200 && (await chatsOf("Sam")).body.data?.chats?.find((x: any) => x.chat === "971522222222")?.lead?.id === asha);
  await incoming("Sam", "971522222222", "It's her brother here", { name: "Stranger" });
  check("…and a later message from that number follows", String((await WhatsAppMessage.findOne({ body: "It's her brother here" }).lean())?.lead) === asha);
  await incoming("Sam", "971533333333", "I want to join", { name: "Rahul Nair" });
  r = await call("POST", "/whatsapp/create-lead", "Sam", { chat: "971533333333" });
  const made = await db.collection("leads").findOne({ phone: "+971533333333" });
  check("a lead made of a chat: its number, their WhatsApp name, source WhatsApp, held by Sam", r.status === 201 && made?.name === "Rahul Nair" && String(made?.source).toLowerCase() === "whatsapp" && String(made?.assignedTo) === String(P("Sam"))
    && (await chatsOf("Sam")).body.data?.chats?.find((x: any) => x.chat === "971533333333")?.lead?.id === String(made?._id), `${r.status} ${r.body.message} ${j(made)}`);
  await incoming("Sam", "971559876543", "Bilal again", { name: "Bilal" });
  r = await call("POST", "/whatsapp/create-lead", "Sam", { chat: "971559876543" });
  check("a number that is a lead after all: linked to it, not made twice", r.status === 200 && r.body.data?.existed === true && r.body.data?.lead?.id === omarLead
    && (await db.collection("leads").countDocuments({ phone: { $regex: "9876543" } })) === 1, `${r.status} ${j(r.body.data)}`);

  section("Case 7 — the lead page's card");
  r = await call("GET", `/whatsapp/lead/${asha}`, "Sam");
  const t = r.body.data?.threads ?? [];
  check("Sam sees his chats with Asha — her number and the one linked to her", r.status === 200 && t.length === 2 && t.every((x: any) => x.ownerId === String(P("Sam"))), j(t.map((x: any) => [x.chat, x.messages.length])));
  check("…her numbers, ready for WhatsApp; he can send", j(r.body.data?.numbers) === j(["971501234567"]) && r.body.data?.canSend === true, j(r.body.data?.numbers));
  r = await call("GET", `/whatsapp/lead/${asha}`, "Omar");
  check("Omar opening her lead sees none of Sam's chats", r.status === 200 && r.body.data?.threads?.length === 0 && r.body.data?.canSend === false, j(r.body.data?.threads));
  r = await call("GET", `/whatsapp/lead/${asha}`, "Lina");
  check("Lina sees Sam's, read only", r.body.data?.threads?.length === 2 && r.body.data?.canSend === false);

  section("Case 8 — photos, files and voice notes");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  r = await form("/whatsapp/send-file", "Sam", { chat: "971501234567", caption: "The brochure" }, { name: "brochure.png", type: "image/png", bytes: png });
  check("a photo: sent as an image with its caption, kept", r.status === 200 && (samSent.at(-1)?.content as any)?.image && (samSent.at(-1)?.content as any)?.caption === "The brochure", `${r.status} ${r.body.message}`);
  const ogg = new Uint8Array(Buffer.from("OggS-fake-voice"));
  r = await form("/whatsapp/send-file", "Sam", { chat: "971501234567", voice: "1" }, { name: "voice-note.ogg", type: "audio/ogg", bytes: ogg });
  check("a voice note recorded in the CRM: sent as one (ptt)", r.status === 200 && (samSent.at(-1)?.content as any)?.ptt === true, `${r.status} ${r.body.message}`);
  r = await call("GET", `/whatsapp/messages?chat=971501234567`, "Sam");
  const photo = r.body.data?.messages?.find((m: any) => m.media?.type === "image");
  const got = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url}`) : null;
  check("its signed link opens the photo, with no sign-in", !!got && got.status === 200 && Buffer.from(await got.arrayBuffer()).equals(Buffer.from(png)), `${got?.status} ${photo?.media?.url}`);
  check("…with its length, and parts of it on request", got?.headers.get("content-length") === String(png.length) && got?.headers.get("accept-ranges") === "bytes", j([...(got?.headers ?? [])]));
  const part = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url}`, { headers: { range: "bytes=2-5" } }) : null;
  const partBytes = part ? Buffer.from(await part.arrayBuffer()) : Buffer.alloc(0);
  check("…a part: 206, those bytes, which part of how many", part?.status === 206 && part.headers.get("content-range") === `bytes 2-5/${png.length}` && partBytes.equals(Buffer.from(png.slice(2, 6))), `${part?.status} ${part?.headers.get("content-range")}`);
  const tail = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url}`, { headers: { range: "bytes=-4" } }) : null;
  check("…the last 4 bytes", tail?.status === 206 && Buffer.from(await tail!.arrayBuffer()).equals(Buffer.from(png.slice(-4))));
  const beyond = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url}`, { headers: { range: `bytes=${png.length + 10}-` } }) : null;
  check("…a part past the end: 416", beyond?.status === 416, `${beyond?.status}`);
  const again = (await call("GET", `/whatsapp/messages?chat=971501234567`, "Sam")).body.data?.messages?.find((m: any) => m.id === photo?.id);
  check("asked again, the same link — an audio or video playing isn't reloaded", !!again && again.media.url === photo.media.url, `${again?.media?.url} vs ${photo?.media?.url}`);
  const tampered = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url.replace(/s=[^&]+/, "s=xxxx")}`) : null;
  check("…a link someone changed opens nothing", tampered?.status === 404, `${tampered?.status}`);
  const old = photo ? photo.media.url.replace(/e=\d+/, `e=${Math.floor(Date.now() / 1000) - 10}`) : "";
  const expired = old ? await fetch(`http://127.0.0.1:${port}${old}`) : null;
  check("…an expired one says so (or opens nothing)", expired?.status === 410 || expired?.status === 404, `${expired?.status}`);

  section("Case 9 — no WhatsApp access");
  check("Nora's role has no WhatsApp: the page is refused", (await call("GET", "/whatsapp/status", "Nora")).status === 403);
  check("…and sending", (await call("POST", "/whatsapp/send", "Nora", { chat: "971501234567", text: "x" })).status === 403);
  check("no token: refused", (await fetch(`http://127.0.0.1:${port}/api/v1/whatsapp/status`)).status === 401);

  section("Case 10 — one WhatsApp, two people (2026-11-16): each sees only their own leads' chats; New chat");
  r = await call("PUT", "/whatsapp/sharing", "Sally", { ownerId: String(P("Sam")), userIds: [String(P("Omar"))] });
  check("sharing someone's WhatsApp: Super Admin only", r.status === 403, `${r.status}`);
  r = await call("PUT", "/whatsapp/sharing", "Root", { ownerId: String(P("Sam")), userIds: ["nope"] });
  check("…bad input: refused", r.status === 400, `${r.status}`);
  r = await call("PUT", "/whatsapp/sharing", "Root", { ownerId: String(P("Sam")), userIds: [String(P("Omar"))] });
  check("the Super Admin shares Sam's WhatsApp with Omar", r.status === 200 && j(r.body.data?.users?.map((u: any) => u.name)) === j(["Omar"]), j(r.body));
  r = await call("GET", "/whatsapp/status", "Omar");
  check("Omar's status: Sam's WhatsApp, linked", r.body.data?.me?.sharedFrom?.name === "Sam" && r.body.data?.me?.phoneOwnerId === String(P("Sam")) && r.body.data?.me?.status === "connected", j(r.body.data?.me));
  r = await call("GET", "/whatsapp/status", "Sam");
  check("Sam's status: his own, also used by Omar", r.body.data?.me?.sharedFrom === null && j(r.body.data?.me?.alsoUsedBy?.map((u: any) => u.name)) === j(["Omar"]), j(r.body.data?.me));
  r = await call("GET", "/whatsapp/status", "Root");
  check("…the Super Admin's list says whose Omar uses; may share", (r.body.data?.owners ?? []).find((o: any) => o.name === "Omar")?.usesWhatsAppOf === String(P("Sam")) && r.body.data?.canShare === true);
  check("Omar can't link a phone of his own while sharing, nor unlink Sam's", (await call("POST", "/whatsapp/connect", "Omar")).status === 409 && (await call("POST", "/whatsapp/disconnect", "Omar")).status === 409);
  let wo = await chatsOf("Omar"), ws = await chatsOf("Sam");
  const has = (a: Answer, chat: string) => (a.body.data?.chats ?? []).some((x: any) => x.chat === chat);
  check("Omar's list: Sam's WhatsApp, only the chat of his own lead Bilal", wo.body.data?.ownerId === String(P("Sam")) && has(wo, "971559876543")
    && !has(wo, "971501234567") && !has(wo, "971522222222") && !has(wo, "971533333333") && wo.body.data?.canSend === true, j(wo.body.data?.chats?.map((x: any) => x.chat)));
  check("Sam's: his leads' chats, not Bilal's", has(ws, "971501234567") && has(ws, "971533333333") && !has(ws, "971559876543"), j(ws.body.data?.chats?.map((x: any) => x.chat)));
  r = await call("GET", "/whatsapp/messages?chat=971501234567", "Omar");
  check("Asha's chat: Omar can't open it — it's Sam's", r.status === 403 && /Sam's/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  const sentBefore = samSent.length;
  for (const [what, method, p, body] of [
    ["send in it", "POST", "/whatsapp/send", { chat: "971501234567", text: "Omar here" }],
    ["read it", "POST", "/whatsapp/read", { chat: "971501234567" }],
    ["link it", "POST", "/whatsapp/link", { chat: "971501234567", leadId: omarLead }],
    ["make a lead of it", "POST", "/whatsapp/create-lead", { chat: "971501234567" }],
  ] as const) {
    r = await call(method, p, "Omar", body);
    check(`…nor ${what}`, r.status === 403, `${r.status} ${r.body.message}`);
  }
  check("…nothing went out", samSent.length === sentBefore);
  r = await call("POST", "/whatsapp/send", "Omar", { chat: "971559876543", text: "Omar here, from Sam's WhatsApp" });
  const wOut = await WhatsAppMessage.findOne({ body: "Omar here, from Sam's WhatsApp" }).lean();
  check("Omar sends in Bilal's chat: out of Sam's WhatsApp, kept under Sam, named Omar", r.status === 200 && samSent.length === sentBefore + 1
    && String(wOut?.owner) === String(P("Sam")) && wOut?.sentByName === "Omar" && String(wOut?.sentBy) === String(P("Omar")), `${r.status} ${r.body.message} ${j(wOut)}`);
  r = await form("/whatsapp/send-file", "Omar", { chat: "971559876543", voice: "1" }, { name: "voice-note.ogg", type: "audio/ogg", bytes: new Uint8Array(Buffer.from("OggS-fake-voice")) });
  const wVoice = await WhatsAppMessage.findOne({ owner: P("Sam"), chat: "971559876543", "media.type": "audio" }).sort({ at: -1 }).lean();
  check("…a voice note from him: named Omar too", r.status === 200 && wVoice?.sentByName === "Omar", `${r.status} ${r.body.message} ${j(wVoice?.sentByName)}`);
  // New chat.
  r = await call("POST", "/whatsapp/new-chat", "Omar", { leadId: asha, text: "Hello Asha" });
  check("New chat with Sam's lead: refused, saying whose", r.status === 403 && /Asha Thomas is Sam's lead/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", "/whatsapp/new-chat", "Omar", { number: "050 123 4567", text: "Hello" });
  check("…her number typed in: refused too", r.status === 403 && /Asha Thomas, Sam's lead/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  check("…no lead and no number, a number too short, no message: refused", (await call("POST", "/whatsapp/new-chat", "Omar", { text: "Hi" })).status === 400
    && (await call("POST", "/whatsapp/new-chat", "Omar", { number: "12", text: "Hi" })).status === 400
    && (await call("POST", "/whatsapp/new-chat", "Omar", { leadId: omarLead, text: " " })).status === 400);
  r = await call("POST", "/whatsapp/new-chat", "Omar", { leadId: omarLead, text: "Hi Bilal, Omar again" });
  check("New chat with his own lead: goes into his chat with them", r.status === 201 && r.body.data?.chat === "971559876543" && r.body.data?.lead?.name === "Bilal Khan" && r.body.data?.existed === true, j(r.body));
  r = await call("POST", "/whatsapp/new-chat", "Omar", { number: "+971 54 888 1234", text: "Hi, Omar from the academy" });
  check("New chat with a number that is no lead's: started, his", r.status === 201 && r.body.data?.chat === "971548881234" && r.body.data?.lead === null && r.body.data?.existed === false, j(r.body));
  wo = await chatsOf("Omar"); ws = await chatsOf("Sam");
  check("…in his list, not Sam's", has(wo, "971548881234") && !has(ws, "971548881234"));
  r = await call("GET", "/whatsapp/messages?chat=971548881234", "Sam");
  check("…Sam can't open it", r.status === 403 && /Omar's/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", "/whatsapp/new-chat", "Sam", { number: "971548881234", text: "Hi" });
  check("…nor start it as his", r.status === 403 && /Omar's/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", "/whatsapp/new-chat", "Sam", { number: "+971 55 987 6543", text: "Hi" });
  check("Sam can't start one with Bilal (Omar's lead)", r.status === 403 && /Bilal Khan, Omar's lead/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  // Unread, pop-ups and alerts: each their own.
  const su0 = (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread, ou0 = (await call("GET", "/whatsapp/unread", "Omar")).body.data?.unread;
  const wSince = new Date().toISOString();
  await new Promise((done) => setTimeout(done, 5));
  await incoming("Sam", "971501234567", "Thanks Sam!", { name: "Asha" });
  await incoming("Sam", "971548881234", "Yes please, tell me more", { name: "Hana Rami" });
  const [su, ou] = [await call("GET", `/whatsapp/unread?since=${encodeURIComponent(wSince)}`, "Sam"), await call("GET", `/whatsapp/unread?since=${encodeURIComponent(wSince)}`, "Omar")];
  check("unread: Asha's message counts for Sam only, the new number's for Omar only", su.body.data?.unread === su0 + 1 && ou.body.data?.unread === ou0 + 1,
    `${su0}→${su.body.data?.unread} / ${ou0}→${ou.body.data?.unread}`);
  check("…the pop-ups too", j(su.body.data?.messages?.map((m: any) => m.body)) === j(["Thanks Sam!"]) && j(ou.body.data?.messages?.map((m: any) => m.body)) === j(["Yes please, tell me more"]),
    `${j(su.body.data?.messages)} ${j(ou.body.data?.messages)}`);
  const { holdersOf } = await import("../src/services/whatsapp/holders.js");
  const wh = await holdersOf(String(P("Sam")), [{ chat: "971501234567", lead: asha }, { chat: "971548881234", lead: null }]);
  check("…a new message is told to the chat's holder only", wh?.get("971501234567") === String(P("Sam")) && wh?.get("971548881234") === String(P("Omar")), j([...(wh ?? [])]));
  r = await call("POST", "/whatsapp/read", "Omar", { chat: "971548881234" });
  check("Omar opens it: read; Sam's count untouched", r.status === 200 && r.body.data?.marked === 1 && (await call("GET", "/whatsapp/unread", "Omar")).body.data?.unread === ou0
    && (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread === su0 + 1, j(r.body));
  r = await call("POST", "/whatsapp/create-lead", "Omar", { chat: "971548881234" });
  const hana = await db.collection("leads").findOne({ phone: "+971548881234" });
  check("Omar makes a lead of his chat: his", r.status === 201 && hana?.name === "Hana Rami" && String(hana?.assignedTo) === String(P("Omar")), `${r.status} ${r.body.message} ${j(hana)}`);
  // A lead moved: its chat goes along.
  await db.collection("leads").updateOne({ _id: new Types.ObjectId(omarLead) }, { $set: { assignedTo: P("Sam") } });
  check("Bilal's lead moved to Sam: the chat is Sam's now", has(await chatsOf("Sam"), "971559876543") && !has(await chatsOf("Omar"), "971559876543"));
  await db.collection("leads").updateOne({ _id: new Types.ObjectId(omarLead) }, { $set: { assignedTo: P("Omar") } });
  check("…moved back: Omar's again", has(await chatsOf("Omar"), "971559876543"));
  // Overseers see as before.
  check("the Sales Manager reading Sam's WhatsApp: every chat on it", has(await chatsOf("Mona", "Sam"), "971501234567") && has(await chatsOf("Mona", "Sam"), "971548881234"));
  check("…a Super Admin: every chat", has(await chatsOf("Root", "Sam"), "971559876543") && has(await chatsOf("Root", "Sam"), "971501234567"));
  const wl = await chatsOf("Lina", "Sam");
  check("…Sam's team leader: Sam's chats, not Omar's (not her team)", has(wl, "971501234567") && !has(wl, "971559876543") && !has(wl, "971548881234"), j(wl.body.data?.chats?.map((x: any) => x.chat)));
  // The lead page.
  r = await call("GET", `/whatsapp/lead/${asha}`, "Omar");
  check("Asha's lead page for Omar: no chat of Sam's", r.status === 200 && (r.body.data?.threads ?? []).length === 0, j(r.body.data?.threads?.map((x: any) => x.chat)));
  r = await call("GET", `/whatsapp/lead/${omarLead}`, "Omar");
  check("…Bilal's for Omar: his chat on Sam's WhatsApp; he can send", (r.body.data?.threads ?? []).some((x: any) => x.ownerId === String(P("Sam")) && x.chat === "971559876543")
    && r.body.data?.canSend === true && r.body.data?.me === String(P("Sam")), j(r.body.data?.threads?.map((x: any) => x.chat)));
  r = await call("GET", `/whatsapp/lead/${omarLead}`, "Sam");
  check("…and not for Sam", (r.body.data?.threads ?? []).every((x: any) => x.chat !== "971559876543"), j(r.body.data?.threads?.map((x: any) => x.chat)));
  r = await call("POST", "/whatsapp/new-chat", "Sally", { leadId: asha, text: "Hi" });
  check("Sally (her own WhatsApp): New chat with Sam's lead refused too", r.status === 403 && /Sam's lead/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  // Taken off: back to his own.
  r = await call("PUT", "/whatsapp/sharing", "Root", { ownerId: String(P("Sam")), userIds: [] });
  check("taken off: nobody uses Sam's", r.status === 200 && r.body.data?.users?.length === 0);
  r = await call("GET", "/whatsapp/status", "Omar");
  check("…Omar back on his own WhatsApp", r.body.data?.me?.sharedFrom === null && r.body.data?.me?.phoneOwnerId === String(P("Omar")));
  check("…and can't send from Sam's", (await call("POST", "/whatsapp/send", "Omar", { chat: "971559876543", text: "x" })).status === 409);
  check("…Sam sees every chat on his WhatsApp again", has(await chatsOf("Sam"), "971559876543") && has(await chatsOf("Sam"), "971548881234"));
} finally {
  server.close();
  await mongoose.disconnect();
  fs.rmSync(MEDIA, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
