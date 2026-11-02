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
 *                                 "Reviews"     (one row per end-of-course rating + comment)
 *                                 "Config"      (course JSON, split across A2, A3, … to stay under
 *                                                Google Sheets' 50,000-character cell limit)
 *
 * Translation uses Google Translate through Apps Script's built-in LanguageApp — no API key needed.
 */

const ADMIN_KEY = "change-me-to-a-long-secret";   // <-- change this

const SUB_SHEET = "Submissions";
const CFG_SHEET = "Config";
const COLUMNS = [
  "submittedAt", "submittedAtLocal", "name", "email", "course",
  "segment", "segmentTitle", "attempt", "score", "passed",
  "answers", "secondsOnSegment", "completedCourse", "language"
];
const REVIEW_SHEET = "Reviews";
const REVIEW_COLUMNS = ["submittedAt", "submittedAtLocal", "name", "email", "course", "rating", "comment", "language"];
const CHUNK = 45000;   // characters per Config cell

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function isAdmin(key) { return typeof key === "string" && key.length > 0 && key === ADMIN_KEY; }
function imageFolder() {
  // "<Sheet name> Images" folder beside the spreadsheet (created on first upload).
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = ss.getName() + " Images";
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const existing = parent.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : parent.createFolder(name);
}

/* ---------- GET: course config (public) and submissions (admin) ---------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === "config") {
    const s = sheet(CFG_SHEET);
    const last = s.getLastRow();
    const raw = last >= 2 ? s.getRange(2, 1, last - 1, 1).getValues().map(r => r[0]).join("") : "";
    return json({ ok: true, config: raw ? JSON.parse(raw) : null, updatedAt: last >= 2 ? (s.getRange("B2").getValue() || null) : null });
  }
  if (p.action === "submissions") {
    if (!isAdmin(p.key)) return json({ ok: false, error: "Unauthorized" });
    const s = sheet(SUB_SHEET);
    const rows = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, COLUMNS.length).getValues() : [];
    return json({ ok: true, columns: COLUMNS, rows: rows });
  }
  if (p.action === "reviews") {
    if (!isAdmin(p.key)) return json({ ok: false, error: "Unauthorized" });
    const s = sheet(REVIEW_SHEET);
    const rows = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, REVIEW_COLUMNS.length).getValues() : [];
    return json({ ok: true, columns: REVIEW_COLUMNS, rows: rows });
  }
  return ContentService.createTextOutput("Course backend is running.");
}

/* ---------- POST: save config (admin) or log a submission (public) ---------- */
function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: "Bad request" }); }

  // Read-only / slow actions run without the script lock so they never hold up learners' submissions.
  if (data.action === "translate") {
    if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
    try { return json({ ok: true, results: translateItems(data.items || [], data.source || "en", String(data.target || "")) }); }
    catch (err) { return json({ ok: false, error: String(err) }); }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (data.action === "saveConfig") {
      if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
      if (!data.config || !Array.isArray(data.config.segments)) return json({ ok: false, error: "Invalid config" });
      const s = sheet(CFG_SHEET);
      if (s.getLastRow() === 0) { s.appendRow(["courseJson", "updatedAt"]); s.getRange(1,1,1,2).setFontWeight("bold"); }
      const now = new Date().toISOString();
      const text = JSON.stringify(data.config);
      const parts = [];
      for (let i = 0; i < text.length; i += CHUNK) parts.push([text.slice(i, i + CHUNK)]);
      if (s.getLastRow() >= 2) s.getRange(2, 1, s.getLastRow() - 1, 2).clearContent();
      s.getRange(2, 1, parts.length, 1).setNumberFormat("@").setValues(parts);
      s.getRange("B2").setValue(now);
      return json({ ok: true, updatedAt: now, cells: parts.length });
    }

    if (data.action === "checkKey") {
      return json({ ok: isAdmin(data.key) });
    }

    // Drive video check from admin.html: size / type / sharing, so the dashboard can warn before publishing.
    if (data.action === "driveFileInfo") {
      if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
      try {
        const f = DriveApp.getFileById(String(data.id));
        let publicLink = false;
        try { const a = f.getSharingAccess(); publicLink = (a === DriveApp.Access.ANYONE_WITH_LINK || a === DriveApp.Access.ANYONE); } catch (_) {}
        return json({ ok: true, name: f.getName(), size: f.getSize(), mime: f.getMimeType(), publicLink: publicLink });
      } catch (err) {
        return json({ ok: false, error: "This Google account can't open that file (check the link, or that it's shared with you)." });
      }
    }

    // Image upload from admin.html: saved to a Drive folder next to this sheet, shared read-only
    // by link, and served back as a direct image URL for the course page.
    if (data.action === "uploadImage") {
      if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
      if (!data.data || !/^image\//.test(data.mime || "")) return json({ ok: false, error: "Not an image" });
      const folder = imageFolder();
      const safeName = String(data.name || "image").replace(/[^\w.\-]+/g, "_").slice(0, 80);
      const blob = Utilities.newBlob(Utilities.base64Decode(data.data), data.mime, safeName);
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return json({ ok: true, id: file.getId(), url: "https://lh3.googleusercontent.com/d/" + file.getId(), name: file.getName() });
    }

    // End-of-course review: rating 1–5 required, comment optional
    if (data.type === "review") {
      const rating = Number(data.rating);
      if (!(rating >= 1 && rating <= 5 && Math.round(rating) === rating)) return json({ ok: false, error: "Rating must be 1–5" });
      const r = sheet(REVIEW_SHEET);
      if (r.getLastRow() === 0) { r.appendRow(REVIEW_COLUMNS); r.getRange(1, 1, 1, REVIEW_COLUMNS.length).setFontWeight("bold"); r.setFrozenRows(1); }
      const row = Object.assign({}, data, { rating: rating, comment: String(data.comment || "").slice(0, 2000) });
      // Prefix values that a spreadsheet would treat as formulas, so a comment can't run as one.
      r.appendRow(REVIEW_COLUMNS.map(k => { const v = (k in row) ? row[k] : ""; return (typeof v === "string" && /^[=+\-@]/.test(v)) ? "'" + v : v; }));
      return json({ ok: true });
    }

    // Default: log a quiz submission
    const s = sheet(SUB_SHEET);
    if (s.getLastRow() === 0) {
      s.appendRow(COLUMNS);
      s.getRange(1, 1, 1, COLUMNS.length).setFontWeight("bold");
      s.setFrozenRows(1);
    } else if (s.getLastColumn() < COLUMNS.length) {
      s.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]).setFontWeight("bold");   // add new columns to an older sheet
    }
    s.appendRow(COLUMNS.map(k => (k in data) ? data[k] : ""));
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Translation (Google Translate via LanguageApp) ---------- */
// items: [{ id, text, html }]. Plain-text items are escaped and batched together inside <section> tags
// so one LanguageApp call translates many strings; rich-text (html) items are sent as HTML.
function translateItems(items, source, target) {
  if (!target) throw new Error("No target language");
  const out = {};
  const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  const unesc = h => String(h).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const LIMIT = 4000;
  let batch = [], size = 0;
  const flush = () => {
    if (!batch.length) return;
    const html = batch.map((it, k) => '<section id="t' + k + '">' + (it.html ? it.text : esc(it.text)) + "</section>").join("");
    let res = null;
    try { res = LanguageApp.translate(html, source, target, { contentType: "html" }); } catch (e) { res = null; }
    const found = {};
    if (res) { const re = /<section id="?t(\d+)"?>([\s\S]*?)<\/section>/gi; let m; while ((m = re.exec(res))) found[m[1]] = m[2]; }
    batch.forEach((it, k) => {
      let t = found[k];
      if (t === undefined) {   // batch didn't round-trip cleanly: translate this one on its own
        try { t = LanguageApp.translate(it.html ? it.text : esc(it.text), source, target, { contentType: "html" }); } catch (e) { t = null; }
      }
      out[it.id] = t === null ? { error: true } : { t: it.html ? t.trim() : unesc(t).trim() };
    });
    batch = []; size = 0;
  };
  items.forEach(it => {
    if (!it || !String(it.text || "").trim()) { if (it) out[it.id] = { t: "" }; return; }
    const len = String(it.text).length + 30;
    if (size + len > LIMIT) flush();
    batch.push(it); size += len;
    if (size > LIMIT) flush();
  });
  flush();
  return out;
}
