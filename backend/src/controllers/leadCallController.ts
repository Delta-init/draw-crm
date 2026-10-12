import { Readable } from "node:stream";
import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import type { AuthenticatedRequest } from "../types/index.js";
import { LeadCall } from "../models/LeadCall.js";
import { leadCallService, canSeeCall, type CallFilters } from "../services/leadCallService.js";
import {
  BACKFILL_DAYS, LINK_TTL_S, checkRecordingLink, getCallSettings, recordingPath, recordingSource, syncCalls, syncExtensions,
} from "../services/callSyncService.js";
import { threecxConfigured, threecxFetch } from "../lib/threecx.js";
import { isSuperAdmin } from "../services/commissionService.js";
import { sendSuccess, sendError } from "../utils/response.js";

/* The 3CX calls (lead_calls): the Calls page, a lead's Calls section and recordings. See leadCallService.ts. */

const viewerOf = (req: AuthenticatedRequest) => ({ userId: req.user!.userId, role: req.user!.role });
const q = (v: unknown) => (typeof v === "string" ? v : undefined);

/** GET /calls/log — the Calls page. `export=1` (the CSV) needs Export on Calls and returns up to 5,000 rows. */
export const getCallLog = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const exporting = req.query.export === "1";
    if (exporting && !isSuperAdmin(req.user!.role) && !req.user!.role?.permissions?.calls?.export) {
      sendError(res, "Access denied: you do not have 'export' permission on 'calls'", 403);
      return;
    }
    const f: CallFilters = {
      preset: q(req.query.preset), from: q(req.query.from), to: q(req.query.to),
      direction: q(req.query.direction), result: q(req.query.result), person: q(req.query.person),
      search: q(req.query.search), sort: q(req.query.sort), order: q(req.query.order),
      page: q(req.query.page), limit: q(req.query.limit),
    };
    const data = await leadCallService.list(viewerOf(req), f, { maxLimit: exporting ? 5000 : 200 });
    sendSuccess(res, "Calls fetched", data);
  } catch (err) {
    next(err);
  }
};

/** GET /calls/log/lead/:leadId — a lead's 3CX calls. */
export const getLeadCallLog = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, "Lead calls fetched", await leadCallService.forLead(viewerOf(req), req.params.leadId!));
  } catch (err) {
    next(err);
  }
};

/** GET /calls/log/:id/recording-link?index= — a link valid 10 minutes, for whoever may see the call. */
export const getRecordingLink = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id ?? "";
    if (!Types.ObjectId.isValid(id)) { sendError(res, "Call not found", 404); return; }
    const call = await LeadCall.findById(id).lean();
    if (!call) { sendError(res, "Call not found", 404); return; }
    if (!(await canSeeCall(viewerOf(req), call))) { sendError(res, "Access denied: not one of your calls", 403); return; }
    const index = Number.isInteger(Number(req.query.index)) ? Number(req.query.index) : 0;
    if (!recordingSource(call, index)) { sendError(res, "No recording for this call", 404); return; }
    sendSuccess(res, "Recording link", { url: recordingPath(String(call._id), index, req.user!.userId), expiresIn: LINK_TTL_S });
  } catch (err) {
    next(err);
  }
};

const AUDIO_TYPES: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", webm: "audio/webm" };

/**
 * GET /calls/log/recording?c&i&e&u&s — the audio, streamed from 3CX (range requests pass through, so it can be
 * scrubbed). No sign-in header (an <audio> element can't send one): the signed, 10-minute link is the permission.
 */
export const streamRecording = async (req: Request, res: Response): Promise<void> => {
  const params = new URLSearchParams();
  for (const k of ["c", "i", "e", "u", "s"]) params.set(k, typeof req.query[k] === "string" ? (req.query[k] as string) : "");
  const link = checkRecordingLink(params);
  if (!link) { res.status(403).type("text/plain").send("This recording link has expired — play it again from the CRM."); return; }
  const call = await LeadCall.findById(link.callId).lean().catch(() => null);
  const path = recordingSource(call, link.index);
  if (!path) { res.status(404).type("text/plain").send("No recording"); return; }
  const range = req.headers.range;
  let upstream: globalThis.Response;
  try {
    upstream = await threecxFetch(path, { timeoutMs: 180_000, headers: range ? { Range: String(range) } : {} });
  } catch (err) {
    res.status(502).type("text/plain").send(err instanceof Error ? err.message : "3CX did not answer");
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(502).type("text/plain").send(`3CX could not give the recording (HTTP ${upstream.status})`);
    return;
  }
  const given = upstream.headers.get("content-type") ?? "";
  const file = (upstream.headers.get("content-disposition") ?? "").match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] ?? "";
  const ext = (file.split(".").pop() ?? "").toLowerCase();
  res.status(upstream.status);
  res.setHeader("Content-Type", given.startsWith("audio/") ? given : AUDIO_TYPES[ext] ?? "audio/wav");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.setHeader("Content-Disposition", `inline; filename="call-${link.callId}.${AUDIO_TYPES[ext] ? ext : "wav"}"`);
  // helmet's same-origin default would stop the web app (another origin in production) from playing it.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  for (const h of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => res.end()).pipe(res);
};

/** POST /calls/log/sync — Super Admin: fetch new calls from 3CX now (the first import runs in the background). */
export const syncCallsNow = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!threecxConfigured()) {
      sendError(res, "3CX is not connected — set THREECX_URL, THREECX_CLIENT_ID and THREECX_API_KEY on the server", 400);
      return;
    }
    const s = await getCallSettings();
    const firstImport = `The first import is running — ${BACKFILL_DAYS} days of calls. This can take a few minutes.`;
    if (s.lockUntil && new Date(s.lockUntil).getTime() > Date.now()) {
      sendSuccess(res, s.backfilledAt ? "A sync is already running — new calls show in a minute." : firstImport, { started: true });
      return;
    }
    await syncExtensions().catch(() => null);
    const by = req.user!.email;
    if (!s.backfilledAt) {
      void syncCalls(by);
      sendSuccess(res, firstImport, { started: true });
      return;
    }
    const r = await syncCalls(by);
    if (r.ok) sendSuccess(res, r.inserted ? `${r.inserted} new call(s) with leads` : "Up to date — no new calls with leads", r);
    else sendError(res, r.error || r.skipped || "The sync failed", 400);
  } catch (err) {
    next(err);
  }
};
