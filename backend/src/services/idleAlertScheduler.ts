/**
 * Idle-alert Scheduler
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs every 60 seconds. When Settings → Idle alerts → "Send idle alerts" is
 * on, alerts the person, the super admins (and team leaders, if switched on)
 * about anyone at work who used the app today, has not signed out, and has
 * done nothing in it for the set working time — once per quiet stretch (see
 * activityService.sweepIdleUsers). Off, it only closes stretches left open.
 * Not in a process with RUN_SCHEDULERS=false.
 */

import { env } from "../config/env.js";
import { sweepIdleUsers } from "./activityService.js";

const INTERVAL_MS = 60_000;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await sweepIdleUsers();
  } catch (err) {
    console.error("[idleAlerts] tick error:", err);
  } finally {
    running = false;
  }
}

export function startIdleAlertScheduler() {
  if (!env.RUN_SCHEDULERS) {
    console.log("[idleAlerts] RUN_SCHEDULERS is off — no idle alerts from this process");
    return;
  }
  console.log("⏰ Idle-alert scheduler started (checks every 60 s)");
  setInterval(tick, INTERVAL_MS);
}
