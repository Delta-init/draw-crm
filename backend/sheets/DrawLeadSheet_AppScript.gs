/**
 * Draw CRM — "DRAW LEAD SHEET" Google Apps Script
 * ════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 *   Pushes each row of the DRAW LEAD SHEET into the Draw CRM as a Lead.
 *   Unlike the Meta/WhatsApp sheets, this one is maintained by hand, so it
 *   carries a counsellor's own Status / Remark / Follow-up columns. Those are
 *   preserved verbatim in the lead's note rather than mapped onto CRM fields —
 *   a sheet saying "Follow Up" is somebody's shorthand, not the CRM's status.
 *
 * SHEET LAYOUT  (sheet name: "Sheet1")
 *   A  Name              ← header cell is blank in the source file
 *   B  Phone Number      ← may carry Facebook's "p:" prefix
 *   C  Platform          e.g. Meta
 *   D  Course            e.g. DRAW
 *   E  Email
 *   F  Status            Follow Up / No Response / ...
 *   G  Assigned          counsellor NAME, e.g. JERIN
 *   H  Remark
 *   I  Follow Up 1
 *   J  Follow up 2
 *   K  Follow up 3
 *   L  CRM Sync          ← written by this script, created if missing
 *
 * SETUP (once)
 *   1. Open the sheet → Extensions → Apps Script → paste this file.
 *   2. Fill in CRM_API_URL and SHEETS_API_KEY below.
 *   3. Run setupTriggers() ONCE from the Run menu, then authorize.
 *   4. Run syncAllRows() once to backfill everything already in the sheet.
 *
 * ASSIGNMENT
 *   Leads are created UNASSIGNED and the CRM splits them. Column G's
 *   counsellor is kept in the lead's note for reference, not acted on.
 *
 * Duplicates are decided by the CRM, on phone number — re-running is safe.
 * ════════════════════════════════════════════════════════════════════
 */

// ─── ⚙️  CONFIGURATION ────────────────────────────────────────────────────────

/** Draw CRM API base, no trailing slash. Must end in /api/v1 */
var CRM_API_URL = "https://api-draw-crm.deltainstitutions.com/api/v1";

/** Must match SHEETS_API_KEY in the Draw backend .env */
var SHEETS_API_KEY = "PASTE_DRAW_SHEETS_API_KEY_HERE";

/** Sheet tab name */
var SHEET_NAME = "Sheet1";

/**
 * Leads are pushed in UNASSIGNED, and the CRM decides who gets them.
 *
 * Column G already names a counsellor for every row in this sheet, but that
 * is the sheet's own roster, not the CRM's — carrying it over would bypass
 * the CRM's round-robin and hand leads to whoever the sheet happened to say.
 * The name is still written into the lead's note, so nothing is lost and a
 * manager can see who had been working it.
 *
 * Set this to true only if column G holds CRM user IDs rather than names.
 */
var ASSIGN_FROM_SHEET = false;

/** Source label written on every lead from this sheet. */
var LEAD_SOURCE = "draw - lead sheet";

// ─── Column indices (0-based) ─────────────────────────────────────────────────

var COL = {
  NAME:        0,   // A
  PHONE:       1,   // B
  PLATFORM:    2,   // C
  COURSE:      3,   // D
  EMAIL:       4,   // E
  STATUS:      5,   // F
  ASSIGNED:    6,   // G
  REMARK:      7,   // H
  FOLLOWUP_1:  8,   // I
  FOLLOWUP_2:  9,   // J
  FOLLOWUP_3: 10,   // K
  CRM_SYNC:   11,   // L
};

var HEADER_ROW = 1;
var FIRST_DATA_ROW = 2;
var BATCH_SIZE = 100;          // server rejects anything over 200

var SYNC = {
  SYNCED:    "✅ SYNCED",
  DUPLICATE: "⚠️ DUPLICATE",
  ERROR:     "❌ ERROR",
  SKIPPED:   "— SKIPPED",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sheet_() {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!s) throw new Error('Sheet "' + SHEET_NAME + '" not found.');
  return s;
}

/** Make sure column L exists and is labelled, so a fresh sheet self-heals. */
function ensureSyncColumn_(sh) {
  if (sh.getMaxColumns() < COL.CRM_SYNC + 1) {
    sh.insertColumnsAfter(sh.getMaxColumns(), COL.CRM_SYNC + 1 - sh.getMaxColumns());
  }
  var head = sh.getRange(HEADER_ROW, COL.CRM_SYNC + 1).getValue();
  if (!head) sh.getRange(HEADER_ROW, COL.CRM_SYNC + 1).setValue("CRM Sync");
}

/**
 * Normalise a phone cell.
 *
 * The sheet stores "p:+971522281281". Sheets also silently turns some numbers
 * into a float, which would arrive as 9.71522281281e+11 and be unusable, so
 * anything numeric is stringified without exponent notation first.
 */
function cleanPhone_(raw) {
  if (raw === null || raw === undefined) return "";
  var s = typeof raw === "number" ? raw.toFixed(0) : String(raw);
  return s.replace(/^p:/i, "").replace(/\s+/g, "").trim();
}

function cleanEmail_(raw) {
  var e = String(raw || "").trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(e) ? e : "";
}

/** Fold the hand-kept columns into one block for the lead's note. */
function buildSheetNotes_(row) {
  var out = [];
  var add = function (label, value) {
    var v = String(value || "").trim();
    if (v) out.push(label + ": " + v);
  };
  add("Status", row[COL.STATUS]);
  add("Counsellor in sheet", row[COL.ASSIGNED]);
  add("Course", row[COL.COURSE]);
  add("Remark", row[COL.REMARK]);
  add("Follow Up 1", row[COL.FOLLOWUP_1]);
  add("Follow Up 2", row[COL.FOLLOWUP_2]);
  add("Follow Up 3", row[COL.FOLLOWUP_3]);
  return out.join("\n");
}

/** Turn one sheet row into the payload the CRM expects. */
function buildPayload_(row) {
  var phone = cleanPhone_(row[COL.PHONE]);
  var name = String(row[COL.NAME] || "").trim();
  if (!phone || !name) return null;

  var payload = {
    full_name: name,
    phone_number: phone,
    platform: String(row[COL.PLATFORM] || "Meta").trim(),
    source: LEAD_SOURCE,
    sheet_notes: buildSheetNotes_(row),
  };

  var email = cleanEmail_(row[COL.EMAIL]);
  if (email) payload.email = email;

  // Deliberately no assigned_to: the CRM splits these itself. Sending the
  // sheet's counsellor would skip that and assign on the sheet's authority.
  if (ASSIGN_FROM_SHEET) {
    var raw = String(row[COL.ASSIGNED] || "").trim();
    if (raw) payload.assigned_to = raw;
  }

  return payload;
}

function post_(path, body) {
  var res = UrlFetchApp.fetch(CRM_API_URL + path, {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": SHEETS_API_KEY },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  var json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON error page */ }
  return { code: code, json: json, text: text };
}

// ─── Main sync ────────────────────────────────────────────────────────────────

/**
 * Push every not-yet-synced row.
 *
 * Rows already marked SYNCED or DUPLICATE are skipped, so this is safe to run
 * repeatedly and safe to run on a trigger. ERROR rows are retried.
 */
function syncAllRows() {
  var lock = LockService.getScriptLock();
  // Two triggers can fire at once — onChange while the timer is mid-run — and
  // without this the same rows are posted twice.
  if (!lock.tryLock(30000)) {
    Logger.log("Another sync is already running; skipping this pass.");
    return;
  }

  try {
    var sh = sheet_();
    ensureSyncColumn_(sh);

    var lastRow = sh.getLastRow();
    if (lastRow < FIRST_DATA_ROW) {
      Logger.log("Nothing to sync.");
      return;
    }

    var values = sh
      .getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, COL.CRM_SYNC + 1)
      .getValues();

    var pending = [];
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var state = String(row[COL.CRM_SYNC] || "").trim();
      if (state === SYNC.SYNCED || state === SYNC.DUPLICATE) continue;

      var payload = buildPayload_(row);
      if (!payload) {
        // No name or no phone — nothing the CRM could store.
        sh.getRange(FIRST_DATA_ROW + i, COL.CRM_SYNC + 1).setValue(SYNC.SKIPPED);
        continue;
      }
      pending.push({ sheetRow: FIRST_DATA_ROW + i, payload: payload });
    }

    if (!pending.length) {
      Logger.log("Everything already synced.");
      return;
    }

    Logger.log("Syncing " + pending.length + " row(s)…");

    for (var start = 0; start < pending.length; start += BATCH_SIZE) {
      var slice = pending.slice(start, start + BATCH_SIZE);
      sendBatch_(sh, slice);
      // Keeps well inside Apps Script's 6-minute execution ceiling and is
      // gentle on the CRM when backfilling a few hundred rows.
      Utilities.sleep(500);
    }

    SpreadsheetApp.flush();
    Logger.log("Done.");
  } finally {
    lock.releaseLock();
  }
}

function sendBatch_(sh, slice) {
  var rows = slice.map(function (p) { return p.payload; });
  var res = post_("/sheets/sync/batch", { rows: rows });

  // 201, not 200: the batch endpoint reports created resources. Checking for
  // 200 alone would mark every successful row as an error.
  var ok = (res.code === 200 || res.code === 201) && res.json && res.json.success;
  if (!ok) {
    var msg = (res.json && res.json.message) || ("HTTP " + res.code);
    Logger.log("Batch failed: " + msg);
    slice.forEach(function (p) {
      sh.getRange(p.sheetRow, COL.CRM_SYNC + 1).setValue(SYNC.ERROR + " " + msg);
    });
    return;
  }

  // The server returns one result per row, keyed by its index in what we sent,
  // so map each verdict back to the sheet row it came from.
  var results = (res.json.data && res.json.data.results) || [];
  var byIndex = {};
  results.forEach(function (r) { byIndex[r.index] = r; });

  slice.forEach(function (p, i) {
    var r = byIndex[i];
    var cell = sh.getRange(p.sheetRow, COL.CRM_SYNC + 1);
    if (!r) { cell.setValue(SYNC.SYNCED); return; }

    if (r.status === "created")        cell.setValue(SYNC.SYNCED);
    else if (r.status === "duplicate") cell.setValue(SYNC.DUPLICATE);
    else                               cell.setValue(SYNC.ERROR + " " + (r.reason || "invalid"));
  });
}

// ─── Triggers ─────────────────────────────────────────────────────────────────

function onChangeTrigger(e) {
  syncAllRows();
}

/** Run ONCE from the Run menu. Safe to re-run; it clears its own triggers first. */
function setupTriggers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === "onChangeTrigger" || fn === "syncAllRows") ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger("onChangeTrigger").forSpreadsheet(ss).onChange().create();

  // Safety net: onChange does not fire for every edit path, and a failed CRM
  // call leaves ERROR rows that should be retried without anyone noticing.
  ScriptApp.newTrigger("syncAllRows").timeBased().everyMinutes(30).create();

  Logger.log("Triggers installed: onChange + every 30 minutes.");
}

/** Clears the CRM Sync column so the next run re-posts everything. */
function resetSyncColumn() {
  var sh = sheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return;
  sh.getRange(FIRST_DATA_ROW, COL.CRM_SYNC + 1, lastRow - FIRST_DATA_ROW + 1, 1).clearContent();
  Logger.log("CRM Sync column cleared. The CRM still de-duplicates on phone.");
}

/** Posts the first unsynced row only — use this to check the setup. */
function testSingleRow() {
  var sh = sheet_();
  ensureSyncColumn_(sh);
  var lastRow = sh.getLastRow();
  var values = sh.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, COL.CRM_SYNC + 1).getValues();

  for (var i = 0; i < values.length; i++) {
    var state = String(values[i][COL.CRM_SYNC] || "").trim();
    if (state === SYNC.SYNCED || state === SYNC.DUPLICATE) continue;
    var payload = buildPayload_(values[i]);
    if (!payload) continue;
    Logger.log("Sending: " + JSON.stringify(payload, null, 2));
    var res = post_("/sheets/sync/batch", { rows: [payload] });
    Logger.log("HTTP " + res.code + " → " + res.text.slice(0, 500));
    return;
  }
  Logger.log("No unsynced rows found.");
}
