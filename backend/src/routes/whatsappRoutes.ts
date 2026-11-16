import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { Router, type NextFunction, type Response } from "express";
import multer from "multer";
import { Types } from "mongoose";
import { env } from "../config/env.js";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { WhatsAppLink, WhatsAppMessage } from "../models/WhatsAppMessage.js";
import { LeadService } from "../services/leadService.js";
import { phoneKey, phoneKeys } from "../services/whatsapp/leads.js";
import { canWhatsApp, isSuperAdmin, leadScope, readableOwners, visibleHolders, type Viewer } from "../services/whatsapp/access.js";
import { chatExists, holdChat, holdersOf, nameOf } from "../services/whatsapp/holders.js";
import { phoneOwnerOf, setSharers, sharedFrom, sharersOf, SharingError, tellees } from "../services/whatsapp/sharing.js";
import {
  followupSettings, FollowupError, leadFollowup, saveFollowupSettings, setLeadFollowupStopped,
} from "../services/whatsapp/followups.js";
import {
  connect, disconnect, forgetLeads, intlNumbers, leadsByKey, mediaPath, sendFile, sendText, status, toIntl, whatsappEnabled, WhatsAppError,
} from "../services/whatsapp/service.js";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendError, sendSuccess } from "../utils/response.js";

/* ────────────────────────────────────────────────────────────────────────────
   The WhatsApp page and the lead page's WhatsApp card (2026-10-27, as in CS
   Portal; services/whatsapp/service.ts does the WhatsApp side).

   Each person links their own WhatsApp and is the only one who sends from it —
   with whoever a Super Admin shared it with (services/whatsapp/sharing.ts,
   2026-11-16), each seeing only their own leads' chats on it (holders.ts):
   "your WhatsApp" below is that one.
   Who reads it (services/whatsapp/access.ts): its owner; their team leader; the
   Sales Manager and a Super Admin — everyone's.
──────────────────────────────────────────────────────────────────────────── */

const router = Router();
const leadService = new LeadService();
const viewer = (req: AuthenticatedRequest): Viewer => ({ userId: req.user!.userId, role: req.user!.role ?? null });
const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const isId = (v: string) => /^[a-f0-9]{24}$/.test(v);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** A WhatsApp failure as the answer; anything else on to the error handler. */
function fail(res: Response, next: NextFunction, err: unknown) {
  if (err instanceof WhatsAppError || err instanceof SharingError) { sendError(res, err.message, err.statusCode); return; }
  next(err);
}

/** The WhatsApp this person uses — their own, or the one shared with them. */
const phoneOf = (req: AuthenticatedRequest) => phoneOwnerOf(req.user!.userId);
/** Who sends, when it isn't the phone's owner (someone it is shared with): named on the message. */
async function senderOn(req: AuthenticatedRequest, phone: string) {
  if (phone === req.user!.userId) return undefined;
  const u = await User.findById(req.user!.userId).select("name email").lean<{ name?: string; email?: string } | null>();
  return { id: req.user!.userId, name: String(u?.name || u?.email || "") };
}

/* ── Photos and files, on short-lived signed links (an <img> carries no token) ── */

const MEDIA_TTL_S = 60 * 60;
const sign = (payload: string) => createHmac("sha256", `${env.JWT_SECRET}|whatsapp-media`).update(payload).digest("base64url");
/**
 * A file's link — the same for an hour (2026-10-28): the chat asks again every few seconds, and a link that changed
 * each time made the page reload an audio or video mid-play. Good for one to two hours from when it is given.
 */
function mediaUrl(messageId: string, userId: string): string {
  const e = (Math.floor(Date.now() / 1000 / MEDIA_TTL_S) + 2) * MEDIA_TTL_S;
  const q = new URLSearchParams({ m: messageId, e: String(e), u: userId, s: sign(`${messageId}.${e}.${userId}`) });
  return `/api/v1/whatsapp/media?${q}`;
}

/** GET /whatsapp/media?m=&e=&u=&s= — a photo or file from a chat, for whoever was given the link. */
router.get("/media", async (req, res, next) => {
  try {
    const m = str(req.query.m, 40), e = str(req.query.e, 20), u = str(req.query.u, 40), s = str(req.query.s, 100);
    if (!isId(m) || !/^\d{9,11}$/.test(e) || !isId(u) || !s) { sendError(res, "Not found", 404); return; }
    if (Number(e) < Date.now() / 1000) { sendError(res, "This link has expired — reopen the chat", 410); return; }
    const want = Buffer.from(sign(`${m}.${e}.${u}`)), got = Buffer.from(s);
    if (want.length !== got.length || !timingSafeEqual(want, got)) { sendError(res, "Not found", 404); return; }
    const doc = await WhatsAppMessage.findById(m).select("media").lean();
    const path = doc?.media?.file ? mediaPath(doc.media.file) : "";
    if (!path || !existsSync(path)) { sendError(res, "Not found", 404); return; }
    const name = String(doc!.media!.fileName || doc!.media!.file.split("/").pop() || "file").replace(/[^\w.\- ]+/g, "_");
    res.setHeader("Content-Type", doc!.media!.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    // Its length, and parts of it on request: an audio or video plays through, shows its length and can be skipped
    // in (Safari plays none without).
    const size = statSync(path).size;
    res.setHeader("Accept-Ranges", "bytes");
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "").trim());
    if (req.headers.range && range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(path, { start, end }).on("error", next).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(size));
    createReadStream(path).on("error", next).pipe(res);
  } catch (err) { next(err); }
});

type MessageDoc = { _id: Types.ObjectId; direction: string; body?: string; at: Date; senderName?: string; sentByName?: string;
  media?: { type: string; mime: string; fileName: string; size: number; file: string } | null; auto?: { step: number; of: number } | null };
const shape = (m: MessageDoc, viewerId: string) => ({
  id: String(m._id),
  direction: m.direction,
  body: m.body ?? "",
  at: m.at,
  senderName: m.senderName ?? "",
  sentByName: m.sentByName ?? "",
  media: m.media ? { type: m.media.type, mime: m.media.mime, fileName: m.media.fileName, size: m.media.size, url: m.media.file ? mediaUrl(String(m._id), viewerId) : "" } : null,
  // Sent by the CRM on its own: an automatic follow-up, its step.
  auto: m.auto ? { step: m.auto.step, of: m.auto.of } : null,
});

async function leadsBrief(ids: unknown[]) {
  const oids = [...new Set(ids.filter(Boolean).map(String))].filter(isId).map((i) => new Types.ObjectId(i));
  if (!oids.length) return new Map<string, { id: string; name: string; status: string; owner: string }>();
  const docs = await Lead.find({ _id: { $in: oids } }).select("name status assignedTo").populate("assignedTo", "name")
    .lean<{ _id: Types.ObjectId; name?: string; status?: string; assignedTo?: { name?: string } | null }[]>();
  return new Map(docs.map((d) => [String(d._id), { id: String(d._id), name: String(d.name ?? "").trim(), status: d.status ?? "", owner: d.assignedTo?.name ?? "" }]));
}

/** The owner asked about (yours by default) — one the viewer may read, or the refusal. */
async function ownerFor(req: AuthenticatedRequest, res: Response, raw: unknown): Promise<string | null> {
  const owner = str(raw, 40) || await phoneOf(req);
  if (!isId(owner)) { sendError(res, "Bad ownerId", 400); return null; }
  const owners = await readableOwners(viewer(req));
  if (owners && !owners.has(owner)) { sendError(res, "Only its owner, their team leader, the Sales Manager and a Super Admin read these chats", 403); return null; }
  return owner;
}

/* ── One WhatsApp, more than one person: each chat is one person's (services/whatsapp/holders.ts) ── */

/** The lead a chat is of: by its number (its latest message's, else the chat's own), else the one it was matched to. */
async function leadOfChat(owner: string, chat: string): Promise<Types.ObjectId | null> {
  const last = await WhatsAppMessage.findOne({ owner: new Types.ObjectId(owner), chat }).sort({ at: -1, _id: -1 }).select("key lead").lean<{ key?: string; lead?: Types.ObjectId | null } | null>();
  const key = last?.key || (chat.includes("@") ? "" : phoneKey(chat));
  return (await leadsByKey()).get(key || chat) ?? last?.lead ?? null;
}

/**
 * Why this viewer may not read or send in this chat on `owner`'s WhatsApp — null: they may. Only on a WhatsApp more
 * than one person uses: each their own chats (a team leader also their people's; the Sales Manager and a Super Admin
 * all). `start`: a number with nothing here yet, and whose lead is nobody's on this WhatsApp, is theirs to start.
 */
async function chatRefusal(req: AuthenticatedRequest, owner: string, chat: string, start = false): Promise<string | null> {
  if ((await tellees(owner)).length < 2) return null;   // nobody else uses it: every chat its owner's, as before
  const see = await visibleHolders(viewer(req));
  if (!see) return null;
  const holders = await holdersOf(owner, [{ chat, lead: await leadOfChat(owner, chat) }]);
  if (!holders) return null;
  const holder = holders.get(chat) ?? owner;
  if (see.has(holder)) return null;
  // Nobody's yet: the owner only by default (no lead held here, nobody started it, nothing on it).
  if (start && holder === owner && !(await chatExists(owner, chat))) return null;
  return `This chat is ${await nameOf(holder)}'s — on a shared WhatsApp each person sees and messages their own chats`;
}

/** The chat on `owner`'s WhatsApp, if the viewer may use it; else refused (403) and false. */
async function mayUseChat(req: AuthenticatedRequest, res: Response, owner: string, chat: string, start = false): Promise<boolean> {
  const why = await chatRefusal(req, owner, chat, start);
  if (why) { sendError(res, why, 403); return false; }
  return true;
}

/** A chat started from the CRM (nothing on it before): kept as the sender's — theirs on a shared WhatsApp. */
async function startedBy(req: AuthenticatedRequest, owner: string, chat: string, existed: boolean) {
  if (!existed) await holdChat(owner, chat, req.user!.userId).catch(() => undefined);
}

/** On a WhatsApp more than one person uses, which of these chats the viewer sees — null: all of them. */
async function chatsSeen(req: AuthenticatedRequest, owner: string, refs: { chat: string; lead?: Types.ObjectId | null }[]): Promise<((chat: string) => boolean) | null> {
  if ((await tellees(owner)).length < 2) return null;
  const see = await visibleHolders(viewer(req));
  if (!see) return null;
  const holders = await holdersOf(owner, refs);
  if (!holders) return null;
  return (chat: string) => see.has(holders.get(chat) ?? owner);
}

router.use(authenticate);

/* ── Linking a WhatsApp ─────────────────────────────────────────────────── */

/**
 * GET /whatsapp/status — your own link (status, number, the QR while linking) and, for a team leader, the Sales
 * Manager or a Super Admin, the people whose chats you can read, with whether each has linked.
 */
router.get("/status", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const v = viewer(req);
    const owners = await readableOwners(v);
    let list: unknown[] = [];
    if (!owners || owners.size > 1) {
      const filter: Record<string, unknown> = { status: { $ne: "inactive" } };
      if (owners) filter._id = { $in: [...owners].map((i) => new Types.ObjectId(i)) };
      const [users, teams, counts] = await Promise.all([
        User.find(filter).select("name email whatsappOf").lean<{ _id: Types.ObjectId; name?: string; email?: string; whatsappOf?: Types.ObjectId | null }[]>(),
        Team.find({ status: "active" }).select("name members leaders").lean<{ name?: string; members?: unknown[]; leaders?: unknown[] }[]>(),
        WhatsAppMessage.aggregate<{ _id: Types.ObjectId; n: number }>([{ $group: { _id: "$owner", n: { $sum: 1 } } }]),
      ]);
      const teamOf = new Map<string, string>();
      for (const t of teams) for (const u of [...(t.leaders ?? []), ...(t.members ?? [])]) if (!teamOf.has(String(u))) teamOf.set(String(u), t.name ?? "");
      const n = new Map(counts.map((c) => [String(c._id), c.n]));
      list = users
        .map((u) => { const st = status(String(u._id)); return { id: String(u._id), name: String(u.name || u.email || ""), team: teamOf.get(String(u._id)) ?? "", status: st.status, phone: st.phone, messages: n.get(String(u._id)) ?? 0, usesWhatsAppOf: u.whatsappOf ? String(u.whatsappOf) : null }; })
        // Those with chats or a link first; then by name.
        .sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected") || Number(b.messages > 0) - Number(a.messages > 0) || a.name.localeCompare(b.name));
    }
    const me = await User.findById(v.userId).select("name email").lean<{ name?: string; email?: string } | null>();
    // Someone using another's WhatsApp sees that one as theirs: its link, and whose it is.
    const from = await sharedFrom(v.userId);
    const phone = from?.id ?? v.userId;
    sendSuccess(res, "WhatsApp", {
      enabled: whatsappEnabled(), canLink: canWhatsApp(v, "create"),
      me: { id: v.userId, name: String(me?.name || me?.email || ""), ...status(phone), phoneOwnerId: phone, sharedFrom: from, alsoUsedBy: await sharersOf(phone) },
      canShare: isSuperAdmin(v.role ?? null),
      owners: list,
    });
  } catch (err) { next(err); }
});

/** POST /whatsapp/connect — you start linking your WhatsApp; the QR follows in /status. */
router.post("/connect", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const from = await sharedFrom(req.user!.userId);
    if (from) { sendError(res, `You use ${from.name}'s WhatsApp — a Super Admin can give you your own`, 409); return; }
    await connect(req.user!.userId); sendSuccess(res, "Linking", status(req.user!.userId));
  } catch (err) { fail(res, next, err); }
});

/** POST /whatsapp/disconnect — unlinks your WhatsApp from the CRM. Your chats so far stay. */
router.post("/disconnect", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const from = await sharedFrom(req.user!.userId);
    if (from) { sendError(res, `This is ${from.name}'s WhatsApp — only they (or a Super Admin) unlink it`, 409); return; }
    await disconnect(req.user!.userId); sendSuccess(res, "Unlinked", status(req.user!.userId));
  } catch (err) { fail(res, next, err); }
});

/* ── Chats ──────────────────────────────────────────────────────────────── */

/**
 * GET /whatsapp/chats?ownerId= — one person's chats (yours by default), newest first: who (the lead, else their
 * WhatsApp name), the last message and how many are unread.
 */
router.get("/chats", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owner = await ownerFor(req, res, req.query.ownerId);
    if (!owner) return;
    // A WhatsApp more than one person uses: more chats read, then only the viewer's kept (holders.ts).
    const shared = (await tellees(owner)).length > 1;
    const all = await WhatsAppMessage.aggregate<{ _id: string; last: MessageDoc & { phone?: string; key?: string; lead?: Types.ObjectId | null }; count: number; unread: number; name: string }>([
      { $match: { owner: new Types.ObjectId(owner) } },
      // Newest first; two in one second by the order they came in.
      { $sort: { at: -1, _id: -1 } },
      { $group: {
        _id: "$chat", last: { $first: "$$ROOT" }, count: { $sum: 1 },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "in"] }, { $eq: ["$read", false] }] }, 1, 0] } },
        name: { $max: { $cond: [{ $eq: ["$direction", "in"] }, "$senderName", ""] } },
      } },
      { $sort: { "last.at": -1 } },
      { $limit: shared ? 1500 : 300 },
    ]);
    const byKey = await leadsByKey();
    const leadOf = (r: (typeof all)[number]) => byKey.get(r.last.key || r._id) ?? r.last.lead ?? null;
    const seen = shared ? await chatsSeen(req, owner, all.map((r) => ({ chat: r._id, lead: leadOf(r) }))) : null;
    const rows = (seen ? all.filter((r) => seen(r._id)) : all).slice(0, 300);
    const leads = await leadsBrief(rows.map(leadOf));
    sendSuccess(res, "Chats", {
      ownerId: owner,
      canSend: owner === await phoneOf(req) && canWhatsApp(viewer(req), "create") && status(owner).status === "connected",
      chats: rows.map((r) => {
        const lead = leads.get(String(leadOf(r) ?? "")) ?? null;
        return {
          chat: r._id, phone: r.last.phone ?? "",
          name: lead?.name || r.name || (r.last.phone ? `+${r.last.phone}` : "Unknown"),
          whatsappName: r.name || "",
          lead,
          last: { body: r.last.body ?? "", at: r.last.at, direction: r.last.direction, media: r.last.media?.type ?? null },
          unread: r.unread, count: r.count,
        };
      }),
    });
  } catch (err) { next(err); }
});

/** GET /whatsapp/messages?ownerId=&chat= — one chat, oldest first (the last 300). */
router.get("/messages", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owner = await ownerFor(req, res, req.query.ownerId);
    if (!owner) return;
    const chat = str(req.query.chat, 120);
    if (!chat) { sendError(res, "chat is required", 400); return; }
    if (!(await mayUseChat(req, res, owner, chat))) return;
    const docs = (await WhatsAppMessage.find({ owner: new Types.ObjectId(owner), chat }).sort({ at: -1, _id: -1 }).limit(300).lean<MessageDoc[]>()).reverse();
    sendSuccess(res, "Messages", {
      ownerId: owner, chat,
      canSend: owner === await phoneOf(req) && canWhatsApp(viewer(req), "create") && status(owner).status === "connected",
      messages: docs.map((m) => shape(m, req.user!.userId)),
    });
  } catch (err) { next(err); }
});

/**
 * GET /whatsapp/unread?since= — your own unread WhatsApp: how many, and the messages that came in after `since` (the
 * `now` of your last call), newest first — the menu's count and the pop-ups.
 */
router.get("/unread", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const now = new Date();
    const since = typeof req.query.since === "string" && /^\d{4}-\d{2}-\d{2}T/.test(req.query.since) ? new Date(req.query.since) : null;
    const phone = await phoneOf(req);
    const base = { owner: new Types.ObjectId(phone), direction: "in", read: false };
    // A WhatsApp more than one person uses: only the viewer's chats count, and only theirs pop up (holders.ts).
    let unread: number, seen: ((chat: string) => boolean) | null = null;
    if ((await tellees(phone)).length > 1) {
      const per = await WhatsAppMessage.aggregate<{ _id: string; n: number; key?: string; lead?: Types.ObjectId | null }>([
        { $match: base }, { $sort: { at: -1, _id: -1 } }, { $group: { _id: "$chat", n: { $sum: 1 }, key: { $first: "$key" }, lead: { $first: "$lead" } } },
      ]);
      const keys = await leadsByKey();
      seen = await chatsSeen(req, phone, per.map((r) => ({ chat: r._id, lead: keys.get(r.key || r._id) ?? r.lead ?? null })));
      unread = per.filter((r) => !seen || seen(r._id)).reduce((a, r) => a + r.n, 0);
    } else unread = await WhatsAppMessage.countDocuments(base);
    // By when the CRM got them (a message can carry an older WhatsApp time).
    const fresh = (since ? await WhatsAppMessage.find({ ...base, createdAt: { $gt: since } }).sort({ createdAt: -1 }).limit(seen ? 50 : 5)
      .lean<(MessageDoc & { chat: string; phone?: string; key?: string; lead?: Types.ObjectId | null })[]>() : [])
      .filter((m) => !seen || seen(m.chat)).slice(0, 5);
    // The leads only when there is something new to name (most calls have nothing).
    const byKey = fresh.length ? await leadsByKey() : new Map<string, Types.ObjectId>();
    const leads = fresh.length ? await leadsBrief(fresh.map((m) => byKey.get(m.key || m.chat) ?? m.lead)) : new Map();
    sendSuccess(res, "Unread", {
      unread, now,
      messages: fresh.map((m) => ({
        id: String(m._id), chat: m.chat, at: m.at, body: m.body ?? "",
        name: leads.get(String(byKey.get(m.key || m.chat) ?? m.lead ?? ""))?.name || m.senderName || (m.phone ? `+${m.phone}` : "WhatsApp"),
      })),
    });
  } catch (err) { next(err); }
});

/** POST /whatsapp/read { chat } — your own chat only (someone else reading it leaves it unread for you). */
router.post("/read", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const chat = str(req.body?.chat, 120);
    if (!chat) { sendError(res, "chat is required", 400); return; }
    const phone = await phoneOf(req);
    if (!(await mayUseChat(req, res, phone, chat))) return;
    const r = await WhatsAppMessage.updateMany({ owner: new Types.ObjectId(phone), chat, direction: "in", read: false }, { $set: { read: true } });
    sendSuccess(res, "Read", { marked: r.modifiedCount });
  } catch (err) { next(err); }
});

/** POST /whatsapp/send { chat, text } — from your own WhatsApp; chat is the number (or a chat's address). */
router.post("/send", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const chat = str(req.body?.chat, 120), text = String(req.body?.text ?? "").trim().slice(0, 4000);
    if (!chat || !text) { sendError(res, "chat and text are required", 400); return; }
    const phone = await phoneOf(req);
    const to = chat.includes("@") ? chat : toIntl(chat);
    if (!(await mayUseChat(req, res, phone, to, true))) return;
    const existed = await chatExists(phone, to);
    const saved = await sendText(phone, chat, text, { by: await senderOn(req, phone) });
    await startedBy(req, phone, saved?.chat ?? to, existed);
    sendSuccess(res, "Sent", { chat: saved?.chat ?? chat });
  } catch (err) { fail(res, next, err); }
});

/** POST /whatsapp/send-file (form: chat, caption, file, voice?) — a photo, video, audio or document, up to 25 MB; voice=1: a voice note. */
router.post("/send-file", checkPermission("whatsapp", "create"), upload.single("file"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
    const chat = str(req.body?.chat, 120), caption = String(req.body?.caption ?? "").trim().slice(0, 1000);
    const voice = String(req.body?.voice ?? "") === "1";
    if (!chat || !file) { sendError(res, "chat and file are required", 400); return; }
    const phone = await phoneOf(req);
    const to = chat.includes("@") ? chat : toIntl(chat);
    if (!(await mayUseChat(req, res, phone, to, true))) return;
    const existed = await chatExists(phone, to);
    const saved = await sendFile(phone, chat, file.buffer, file.mimetype || "application/octet-stream", file.originalname || "file", voice ? "" : caption, voice,
      { by: await senderOn(req, phone) });
    await startedBy(req, phone, saved?.chat ?? to, existed);
    sendSuccess(res, "Sent", { chat: saved?.chat ?? chat });
  } catch (err) { fail(res, next, err); }
});

/* ── A chat that is no lead's ───────────────────────────────────────────── */

/** The chat's key (its number's last 9 digits, or its address), from its latest message. */
async function chatKey(owner: string, chat: string): Promise<string | null> {
  const last = await WhatsAppMessage.findOne({ owner: new Types.ObjectId(owner), chat }).sort({ at: -1, _id: -1 }).select("key").lean<{ key?: string } | null>();
  return last ? last.key || chat : null;
}

async function linkKey(key: string, leadId: Types.ObjectId, req: AuthenticatedRequest) {
  const me = await User.findById(req.user!.userId).select("name").lean<{ name?: string } | null>();
  await WhatsAppLink.updateOne({ key }, { $set: { key, lead: leadId, by: new Types.ObjectId(req.user!.userId), byName: me?.name ?? "", at: new Date() } }, { upsert: true });
  await WhatsAppMessage.updateMany(/^\d{9}$/.test(key) ? { key } : { chat: key }, { $set: { lead: leadId } });
  forgetLeads();
}

/** GET /whatsapp/lead-options?search= — leads you may link a chat to: by name or number, up to 20. */
router.get("/lead-options", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const q = str(req.query.search, 60);
    const filter: Record<string, unknown> = { ...(await leadScope(viewer(req))) };
    if (q) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // A number typed any way ("050 123 4567", "+97150…") finds the lead by its last 7 digits, spaces and all.
      const tail = q.replace(/\D/g, "").slice(-7);
      const byPhone = tail.length >= 5 ? [{ phone: { $regex: tail.split("").join("[\\s\\-.()]*") } }] : [];
      filter.$and = [{ $or: [{ name: { $regex: esc, $options: "i" } }, ...byPhone] }];
    }
    const leads = await Lead.find(filter).sort({ updatedAt: -1 }).limit(20).select("name phone status").lean<{ _id: Types.ObjectId; name?: string; phone?: string; status?: string }[]>();
    sendSuccess(res, "Leads", leads.map((l) => ({ id: String(l._id), name: String(l.name ?? "").trim(), phone: l.phone ?? "", status: l.status ?? "" })));
  } catch (err) { next(err); }
});

/**
 * POST /whatsapp/link { ownerId?, chat, leadId } — a number on no lead's record is theirs: the chat, its earlier
 * messages and anything that comes later from that number show under the lead. By whoever reads the chat and may see
 * the lead.
 */
router.post("/link", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owner = await ownerFor(req, res, req.body?.ownerId);
    if (!owner) return;
    const chat = str(req.body?.chat, 120), leadId = str(req.body?.leadId, 40);
    if (!chat || !isId(leadId)) { sendError(res, "chat and leadId are required", 400); return; }
    if (!(await mayUseChat(req, res, owner, chat))) return;
    const lead = await Lead.findOne({ _id: new Types.ObjectId(leadId), ...(await leadScope(viewer(req))) }).select("name").lean<{ _id: Types.ObjectId; name?: string } | null>();
    if (!lead) { sendError(res, "You can link chats only to leads you can see", 403); return; }
    const key = await chatKey(owner, chat);
    if (!key) { sendError(res, "No such chat", 404); return; }
    await linkKey(key, lead._id, req);
    sendSuccess(res, "Linked", { lead: { id: String(lead._id), name: String(lead.name ?? "").trim() } });
  } catch (err) { next(err); }
});

/**
 * POST /whatsapp/create-lead { ownerId?, chat, name? } — a lead made of a chat that is no lead's: its number, the name
 * given (else their WhatsApp name), source WhatsApp, held by the person whose WhatsApp it is. A number that turns out
 * to be a lead after all is linked to it instead.
 */
router.post("/create-lead", checkPermission("whatsapp", "create"), checkPermission("leads", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owner = await ownerFor(req, res, req.body?.ownerId);
    if (!owner) return;
    const chat = str(req.body?.chat, 120);
    if (chat && !(await mayUseChat(req, res, owner, chat))) return;
    const last = chat ? await WhatsAppMessage.findOne({ owner: new Types.ObjectId(owner), chat }).sort({ at: -1, _id: -1 }).select("phone key senderName direction").lean<{ phone?: string; key?: string } | null>() : null;
    if (!last) { sendError(res, "No such chat", 404); return; }
    if (!last.phone) { sendError(res, "WhatsApp didn't give this chat's number — link it to a lead instead", 400); return; }
    const existingId = (await leadsByKey()).get(phoneKey(last.phone));
    const existing = existingId ? await Lead.findById(existingId).select("name").lean<{ _id: Types.ObjectId; name?: string } | null>() : null;
    if (existing) {
      await linkKey(last.key || chat, existing._id, req);
      sendSuccess(res, "Already a lead — linked to it", { lead: { id: String(existing._id), name: String(existing.name ?? "").trim() }, existed: true });
      return;
    }
    const inName = await WhatsAppMessage.findOne({ owner: new Types.ObjectId(owner), chat, direction: "in", senderName: { $gt: "" } }).sort({ at: -1 }).select("senderName").lean<{ senderName?: string } | null>();
    const name = str(req.body?.name, 100) || (inName?.senderName && !/^\d+$/.test(inName.senderName) ? inName.senderName : "") || `WhatsApp +${last.phone}`;
    // Held by whose WhatsApp it is — or by the one making it there, when it is shared with them.
    const holder = owner === await phoneOf(req) ? req.user!.userId : owner;
    const lead = await leadService.createLead({ name, phone: `+${last.phone}`, source: "WhatsApp", assignedTo: holder }, req.user!.userId) as unknown as { _id: Types.ObjectId };
    await linkKey(last.key || chat, lead._id, req);
    sendSuccess(res, "Lead created", { lead: { id: String(lead._id), name }, existed: false }, 201);
  } catch (err) { next(err); }
});

/* ── The lead page ──────────────────────────────────────────────────────── */

/**
 * GET /whatsapp/lead/:leadId — the lead's WhatsApp chats you may read (yours with them, and for a team leader, the
 * Sales Manager or a Super Admin their people's), and the numbers on their record, to message them from your own.
 */
router.get("/lead/:leadId", checkPermission("whatsapp", "view"), checkPermission("leads", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const leadId = str(req.params.leadId, 40);
    if (!isId(leadId)) { sendError(res, "Lead not found", 404); return; }
    const lead = await Lead.findById(leadId).select("phone").lean<{ phone?: string } | null>();
    if (!lead) { sendError(res, "Lead not found", 404); return; }
    const v = viewer(req);
    const owners = await readableOwners(v);
    const linked = (await WhatsAppLink.find({ lead: new Types.ObjectId(leadId) }).select("key").lean()).map((l) => l.key);
    const filter: Record<string, unknown> = { $or: [{ key: { $in: [...phoneKeys(lead.phone), ...linked] } }, { chat: { $in: linked } }, { lead: new Types.ObjectId(leadId) }] };
    if (owners) filter.owner = { $in: [...owners].map((i) => new Types.ObjectId(i)) };
    const docs = (await WhatsAppMessage.find(filter).sort({ at: -1, _id: -1 }).limit(400).lean<(MessageDoc & { owner: Types.ObjectId; ownerName?: string; chat: string; phone?: string })[]>()).reverse();
    const threads = new Map<string, { ownerId: string; ownerName: string; chat: string; phone: string; messages: ReturnType<typeof shape>[] }>();
    for (const m of docs) {
      const k = `${m.owner}|${m.chat}`;
      if (!threads.has(k)) threads.set(k, { ownerId: String(m.owner), ownerName: m.ownerName ?? "", chat: m.chat, phone: m.phone ?? "", messages: [] });
      threads.get(k)!.messages.push(shape(m, v.userId));
    }
    // A WhatsApp more than one person uses: its chat with this lead only for whose it is (holders.ts).
    for (const owner of new Set([...threads.values()].map((t) => t.ownerId))) {
      const here = [...threads.entries()].filter(([, t]) => t.ownerId === owner);
      const seen = await chatsSeen(req, owner, here.map(([, t]) => ({ chat: t.chat, lead: new Types.ObjectId(leadId) })));
      if (seen) for (const [k, t] of here) if (!seen(t.chat)) threads.delete(k);
    }
    const phone = await phoneOwnerOf(v.userId);
    const mine = status(phone);
    const canLink = canWhatsApp(v, "create");
    sendSuccess(res, "WhatsApp", {
      // Where the automatic follow-ups stand for this lead (services/whatsapp/followups.ts).
      followup: await leadFollowup(leadId),
      numbers: intlNumbers(lead.phone),
      canSend: canLink && mine.status === "connected",
      canLink,
      linked: mine.status === "connected",
      me: phone,
      threads: [...threads.values()].sort((a, b) => Number(b.ownerId === phone) - Number(a.ownerId === phone)),
    });
  } catch (err) { next(err); }
});

/* ── New chat (2026-11-16) ───────────────────────────────────────────── */

/** The lead's holder's name, for "That's Sara's lead". */
async function holderName(leadId: unknown): Promise<{ name: string; holder: string }> {
  const l = await Lead.findById(leadId).select("name assignedTo").populate("assignedTo", "name email")
    .lean<{ name?: string; assignedTo?: { name?: string; email?: string } | null } | null>();
  return { name: String(l?.name ?? "").trim(), holder: String(l?.assignedTo?.name || l?.assignedTo?.email || "nobody") };
}

/**
 * POST /whatsapp/new-chat { leadId? | number?, text } — a chat started from your WhatsApp: one of your leads (a team
 * leader: their people's too; `number`: which of theirs), or a number typed in, and the first message. Another
 * person's lead is refused, saying whose; so is a number whose chat on a shared WhatsApp is someone else's. A number
 * that is no lead's becomes your chat.
 */
router.post("/new-chat", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const text = String(req.body?.text ?? "").trim().slice(0, 4000);
    const leadId = str(req.body?.leadId, 40), typed = str(req.body?.number, 40);
    if (!text) { sendError(res, "Type the first message", 400); return; }
    if (!leadId && !typed) { sendError(res, "Pick one of your leads or type a number", 400); return; }
    const scope = await leadScope(viewer(req));
    let number = "", lead: { id: string; name: string } | null = null;
    if (leadId) {
      if (!isId(leadId)) { sendError(res, "Lead not found", 404); return; }
      const l = await Lead.findById(leadId).select("name phone").lean<{ _id: Types.ObjectId; name?: string; phone?: string } | null>();
      if (!l) { sendError(res, "Lead not found", 404); return; }
      if (!(await Lead.exists({ _id: l._id, ...scope }))) {
        const h = await holderName(l._id);
        sendError(res, `${h.name || "This lead"} is ${h.holder}'s lead — only they message them`, 403); return;
      }
      // Which of their numbers (a lead's field can hold two): the one picked, else the first.
      const nums = intlNumbers(l.phone);
      number = typed && nums.includes(toIntl(typed)) ? toIntl(typed) : nums[0] ?? "";
      if (!number) { sendError(res, "This lead has no phone number to message", 400); return; }
      lead = { id: String(l._id), name: String(l.name ?? "").trim() };
    } else {
      number = toIntl(typed);
      if (!/^\d{9,15}$/.test(number)) { sendError(res, "Type the number with its country code, e.g. +971 50 123 4567", 400); return; }
      const known = (await leadsByKey()).get(phoneKey(number));
      if (known) {
        if (!(await Lead.exists({ _id: known, ...scope }))) {
          const h = await holderName(known);
          sendError(res, `That number is ${h.name || "a lead"}, ${h.holder}'s lead — only they message them`, 403); return;
        }
        const l = await Lead.findById(known).select("name").lean<{ name?: string } | null>();
        lead = { id: String(known), name: String(l?.name ?? "").trim() };
      }
    }
    const phone = await phoneOf(req);
    if (!(await mayUseChat(req, res, phone, number, true))) return;
    const existed = await chatExists(phone, number);
    const saved = await sendText(phone, number, text, { by: await senderOn(req, phone) });
    const chat = saved?.chat ?? number;
    await startedBy(req, phone, chat, existed);
    sendSuccess(res, existed ? "Sent" : "Chat started", { chat, lead, existed }, 201);
  } catch (err) { fail(res, next, err); }
});

/* ── One WhatsApp, more than one person (services/whatsapp/sharing.ts) ──── */

/** GET /whatsapp/sharing?ownerId= — who else uses this person's WhatsApp. Super Admin. */
router.get("/sharing", async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!isSuperAdmin(req.user!.role ?? null)) { sendError(res, "Only a Super Admin shares a WhatsApp", 403); return; }
    const owner = str(req.query.ownerId, 40);
    if (!isId(owner)) { sendError(res, "Bad ownerId", 400); return; }
    sendSuccess(res, "Shared with", { ownerId: owner, users: await sharersOf(owner) });
  } catch (err) { next(err); }
});

/**
 * PUT /whatsapp/sharing { ownerId, userIds } — exactly these people use this person's WhatsApp: they send from it as
 * their own, each seeing only their own leads' chats on it. [] = nobody. Super Admin.
 */
router.put("/sharing", async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!isSuperAdmin(req.user!.role ?? null)) { sendError(res, "Only a Super Admin shares a WhatsApp", 403); return; }
    const owner = str(req.body?.ownerId, 40);
    const ids = Array.isArray(req.body?.userIds) ? (req.body.userIds as unknown[]).map((x) => str(x, 40)) : null;
    if (!isId(owner) || !ids || ids.length > 10) { sendError(res, "ownerId and userIds (up to 10) are required", 400); return; }
    const users = await setSharers(owner, ids);
    console.log(`[whatsapp] ${owner}'s WhatsApp now also used by: ${users.map((u) => u.name).join(", ") || "nobody"}`);
    sendSuccess(res, "Saved", { ownerId: owner, users });
  } catch (err) { fail(res, next, err); }
});

/* ── Automatic follow-ups (services/whatsapp/followups.ts) ──────────────── */

const superAdminOnly = (req: AuthenticatedRequest, res: Response): boolean => {
  if (isSuperAdmin(req.user!.role ?? null)) return true;
  sendError(res, "Only a Super Admin sets up the automatic follow-ups", 403);
  return false;
};
const myName = async (req: AuthenticatedRequest) => String((await User.findById(req.user!.userId).select("name").lean<{ name?: string } | null>())?.name ?? "");

/** GET /whatsapp/followups/settings — the steps, the teams switched on, the daily limit; and every team to pick from. Super Admin. */
router.get("/followups/settings", async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!superAdminOnly(req, res)) return;
    const teams = await Team.find({ status: "active" }).select("name").sort({ name: 1 }).lean<{ _id: Types.ObjectId; name?: string }[]>();
    sendSuccess(res, "Follow-ups", { ...(await followupSettings(true)), allTeams: teams.map((t) => ({ id: String(t._id), name: t.name ?? "" })) });
  } catch (err) { next(err); }
});

/** PUT /whatsapp/followups/settings { enabled, teams, dailyLimit, steps: [{ waitMinutes, text, file? }] } — Super Admin. */
router.put("/followups/settings", async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!superAdminOnly(req, res)) return;
    sendSuccess(res, "Saved", await saveFollowupSettings((req.body ?? {}) as Record<string, unknown>, await myName(req)));
  } catch (err) {
    if (err instanceof FollowupError) { sendError(res, err.message, err.statusCode); return; }
    next(err);
  }
});

const FOLLOWUP_FILE_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/mp4|audio\/(mpeg|ogg|mp4)|application\/pdf)$/;
/** POST /whatsapp/followups/file (form: file) — a photo, video, audio or PDF for a step, up to 25 MB; kept once, sent to each. Super Admin. */
router.post("/followups/file", upload.single("file"), async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!superAdminOnly(req, res)) return;
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
    if (!file) { sendError(res, "file is required", 400); return; }
    const mime = (file.mimetype || "").split(";")[0]!.trim();
    if (!FOLLOWUP_FILE_TYPES.test(mime)) { sendError(res, "A photo (JPG, PNG, WebP, GIF), an MP4 video, audio or a PDF", 400); return; }
    const ext = (extname(file.originalname || "").toLowerCase().match(/^\.\w{1,10}$/)?.[0]) || `.${mime.split("/")[1]}`;
    const stored = `followups/${randomUUID()}${ext}`;
    await mkdir(mediaPath("followups"), { recursive: true });
    await writeFile(mediaPath(stored), file.buffer);
    sendSuccess(res, "Uploaded", { file: stored, name: file.originalname || `file${ext}`, mime, size: file.size }, 201);
  } catch (err) { next(err); }
});

/** GET /whatsapp/followups/recent — the latest 50 automatic follow-ups from the WhatsApps you may read. */
router.get("/followups/recent", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owners = await readableOwners(viewer(req));
    const filter: Record<string, unknown> = { "auto.kind": "followup" };
    if (owners) filter.owner = { $in: [...owners].map((i) => new Types.ObjectId(i)) };
    const docs = await WhatsAppMessage.find(filter).sort({ at: -1 }).limit(50)
      .lean<(MessageDoc & { owner: Types.ObjectId; ownerName?: string; chat: string; phone?: string; key?: string; lead?: Types.ObjectId | null })[]>();
    const byKey = await leadsByKey();
    const leads = await leadsBrief(docs.map((m) => byKey.get(m.key || m.chat) ?? m.lead));
    sendSuccess(res, "Recent follow-ups", docs.map((m) => ({
      id: String(m._id), at: m.at, body: m.body ?? "", step: m.auto?.step ?? 0, of: m.auto?.of ?? 0,
      ownerId: String(m.owner), ownerName: m.ownerName ?? "", chat: m.chat, phone: m.phone ?? "",
      lead: leads.get(String(byKey.get(m.key || m.chat) ?? m.lead ?? "")) ?? null,
    })));
  } catch (err) { next(err); }
});

/** POST /whatsapp/followups/lead/:leadId/stop | /resume — for whoever may see the lead. Stopped until someone writes to them again. */
for (const action of ["stop", "resume"] as const) {
  router.post(`/followups/lead/:leadId/${action}`, checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
    try {
      const leadId = str(req.params.leadId, 40);
      if (!isId(leadId)) { sendError(res, "Lead not found", 404); return; }
      const lead = await Lead.findOne({ _id: new Types.ObjectId(leadId), ...(await leadScope(viewer(req))) }).select("_id").lean();
      if (!lead) { sendError(res, "You can stop follow-ups only on leads you can see", 403); return; }
      await setLeadFollowupStopped(leadId, action === "stop", await myName(req));
      sendSuccess(res, action === "stop" ? "Follow-ups stopped" : "Follow-ups resumed", { followup: await leadFollowup(leadId) });
    } catch (err) { next(err); }
  });
}

export default router;
