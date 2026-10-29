/**
 * Course backend for course.html + admin.html
 * --------------------------------------------
 * Stores the course content (modules, videos, questions) and logs every quiz submission.
 *
 * SETUP
 * 1. Create a new Google Sheet.
 * 2. Extensions → Apps Script. Delete the sample code, paste this file.
 * 3. Change ADMIN_KEY below to a long private passphrase. Save.
 * 4. Deploy → New deployment → Type: Web app
 *      Execute as: Me      Who has access: Anyone
 *    Deploy, authorize, copy the Web app URL.
 * 5. Paste that URL into CONFIG.logEndpoint in course.html, and into the
 *    "Backend URL" field in admin.html (with the admin key).
 *
 * AFTER EDITING THIS FILE LATER: Deploy → Manage deployments → pencil → Version: New → Deploy.
 * (The URL stays the same; without a new version the live app keeps the old code.)
 *
 * Sheets created automatically:  "Submissions" (one row per quiz attempt)
 *                                 "Config"      (A2 holds the course JSON)
 */

const ADMIN_KEY = "change-me-to-a-long-secret";   // <-- change this

const SUB_SHEET = "Submissions";
const CFG_SHEET = "Config";
const COLUMNS = [
  "submittedAt", "submittedAtLocal", "name", "email", "course",
  "segment", "segmentTitle", "attempt", "score", "passed",
  "answers", "secondsOnSegment", "completedCourse"
];

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function isAdmin(key) { return typeof key === "string" && key.length > 0 && key === ADMIN_KEY; }

/* ---------- GET: course config (public) and submissions (admin) ---------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === "config") {
    const s = sheet(CFG_SHEET);
    const raw = s.getRange("A2").getValue();
    return json({ ok: true, config: raw ? JSON.parse(raw) : null, updatedAt: s.getRange("B2").getValue() || null });
  }
  if (p.action === "submissions") {
    if (!isAdmin(p.key)) return json({ ok: false, error: "Unauthorized" });
    const s = sheet(SUB_SHEET);
    const rows = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, COLUMNS.length).getValues() : [];
    return json({ ok: true, columns: COLUMNS, rows: rows });
  }
  return ContentService.createTextOutput("Course backend is running.");
}

/* ---------- POST: save config (admin) or log a submission (public) ---------- */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.action === "saveConfig") {
      if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
      if (!data.config || !Array.isArray(data.config.segments)) return json({ ok: false, error: "Invalid config" });
      const s = sheet(CFG_SHEET);
      if (s.getLastRow() === 0) { s.appendRow(["courseJson", "updatedAt"]); s.getRange(1,1,1,2).setFontWeight("bold"); }
      const now = new Date().toISOString();
      s.getRange("A2").setValue(JSON.stringify(data.config));
      s.getRange("B2").setValue(now);
      return json({ ok: true, updatedAt: now });
    }

    if (data.action === "checkKey") {
      return json({ ok: isAdmin(data.key) });
    }

    // Default: log a quiz submission
    const s = sheet(SUB_SHEET);
    if (s.getLastRow() === 0) {
      s.appendRow(COLUMNS);
      s.getRange(1, 1, 1, COLUMNS.length).setFontWeight("bold");
      s.setFrozenRows(1);
    }
    s.appendRow(COLUMNS.map(k => (k in data) ? data[k] : ""));
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
