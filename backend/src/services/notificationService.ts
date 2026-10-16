import { Types } from "mongoose";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { Role } from "../models/Role.js";
import { emitToUser } from "../socket.js";
import { sendPushToUsers } from "./pushService.js";
import type { INotification, NotificationDTO } from "../types/index.js";

/**
 * One call to tell people something, every way this CRM can (brought over from
 * the Sales CRM with the Inactive leads page, 2026-10-16 — no email: this CRM
 * has no mailbox):
 *
 *   1. kept as a notification, so the bell still shows it after a reload;
 *   2. live on the socket, as the same "notification" event the bell has
 *      always listened for (now carrying the stored id and its type);
 *   3. as a web push, for a phone in a pocket.
 *
 * It never throws. Telling people is a courtesy on top of something that
 * already happened — a lead moved — and a push service having a bad minute
 * must not undo it.
 */

export interface NotifyInput {
  userIds: Array<string | Types.ObjectId>;
  /** e.g. "inactive_lead_moved". The bell picks its icon from it. */
  type: string;
  title: string;
  body: string;
  /** Where the notice leads, as an app path: "/leads/123". */
  url?: string;
  /** Collapses repeat pushes about the same thing into one on the phone. */
  tag?: string;
}

/** Every active Super Admin — who hears about inactive leads. */
export async function superAdminIds(): Promise<string[]> {
  const roles = await Role.find({ isSystemRole: true, roleName: "Super Admin" }).select("_id").lean();
  if (!roles.length) return [];
  const admins = await User.find({ role: { $in: roles.map((r) => r._id) }, status: { $ne: "inactive" } })
    .select("_id")
    .lean();
  return admins.map((a) => String(a._id));
}

export function toNotificationDTO(n: Pick<INotification, "_id" | "type" | "title" | "body" | "url" | "readAt" | "createdAt">): NotificationDTO {
  return {
    id: String(n._id),
    type: n.type,
    title: n.title,
    body: n.body,
    url: n.url,
    read: Boolean(n.readAt),
    createdAt: new Date(n.createdAt).toISOString(),
  };
}

export async function notify(input: NotifyInput): Promise<void> {
  const userIds = [...new Set(input.userIds.map(String))].filter((id) => Types.ObjectId.isValid(id));
  if (!userIds.length) return;
  // Cut to what the record holds: a lead's name has no limit, and one too long must not lose the whole notice.
  const title = input.title.slice(0, 200);
  const body = input.body.slice(0, 1000);
  const url = (input.url ?? "").slice(0, 500);

  // 1 + 2 — the record, and the live copy carrying its id.
  try {
    const docs = await Notification.insertMany(
      userIds.map((user) => ({ user, type: input.type, title, body, url }))
    );
    for (const doc of docs) {
      emitToUser(String(doc.user), "notification", toNotificationDTO(doc));
    }
  } catch (err) {
    console.error(`🔔 Could not store "${input.type}" notifications:`, err instanceof Error ? err.message : err);
  }

  // 3 — the phone.
  sendPushToUsers(userIds, {
    title,
    body,
    url: url || undefined,
    tag: input.tag,
    data: { type: input.type },
  }).catch((err) => console.error(`🔔 Push for "${input.type}" failed:`, err instanceof Error ? err.message : err));
}
