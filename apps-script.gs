/**
 * Course backend for course.html + admin.html
 * --------------------------------------------
 * Stores the course content, delivers it to learners one section at a time, grades quiz answers,
 * and logs one row per learner when they finish, plus their end-of-course review.
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
 * Sheets created automatically:  "Submissions" (one row per learner, written when they pass the last section,
 *                                               with a "Section N" column for each section's result)
 *                                 "Reviews"     (one row per end-of-course rating + comment)
 *                                 "Config"      (course JSON, split across A2, A3, … to stay under
 *                                                Google Sheets' 50,000-character cell limit)
 *
 * SECURITY MODEL
 * - Correct answers never leave this script. Learners get questions without answers; this script grades them.
 * - A learner only receives a section after passing the one before it (tracked in a session that lasts 6 hours).
 * - Everything admin-only (full course, submissions, reviews, publishing, uploads, translation) needs ADMIN_KEY,
 *   sent in the request body — never in the web address.
 *
 * Translation uses Google Translate through Apps Script's built-in LanguageApp — no API key needed.
 */

const ADMIN_KEY = "change-me-to-a-long-secret";   // <-- change this
const BACKEND_VERSION = 11;   // admin.html warns when the deployed script is older than it expects

const SUB_SHEET = "Submissions";
const CFG_SHEET = "Config";
// One row per learner who finishes. Column order and headings in the Submissions sheet: [field, heading]. "Section 1", "Section 2", … follow.
const SUB_FIELDS = [
  ["email", "Email"], ["parentLast", "Parent Last Name"], ["parentFirst", "Parent First Name"],
  ["qualifyingLast", "Qualifying Parent Last Name"], ["qualifyingFirst", "Qualifying Parent First Name"],
  ["parentId", "Parent ID"], ["studentLast", "Student Last Name"], ["studentFirst", "Student First Name"],
  ["submittedAtLocal", "Completed"], ["submittedAt", "Completed (UTC)"], ["course", "Course"], ["language", "Language"],
  ["minutes", "Minutes"], ["retries", "Retries"]
];
const SUB_BASE = SUB_FIELDS.map(f => f[1]);
const REVIEW_SHEET = "Reviews";
const REVIEW_COLUMNS = ["submittedAt", "submittedAtLocal", "name", "email", "course", "rating", "comment", "language", "qualifyingParent", "studentName", "parentId"];
const CHUNK = 45000;          // characters per Config cell
const CACHE_CHUNK = 25000;    // characters per cache entry (cache values are capped at 100 KB)
const SESSION_TTL = 21600;    // 6 hours, the longest Apps Script's cache allows

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
// Values starting with = + - @ would be treated as formulas by Sheets; store them as text.
const cellSafe = v => (typeof v === "string" && /^[=+\-@]/.test(v)) ? "'" + v : v;
// IDs are kept exactly as typed: without this, Sheets would turn "00123" into the number 123.
const asText = v => (typeof v === "string" && v && !/^'/.test(v)) ? "'" + v : v;

/* ---------- published course: read through the cache so learners don't each hit the sheet ---------- */
function readConfigFromSheet() {
  const s = sheet(CFG_SHEET);
  const last = s.getLastRow();
  if (last < 2) return { config: null, updatedAt: null };
  const raw = s.getRange(2, 1, last - 1, 1).getValues().map(r => r[0]).join("");
  return { config: raw ? JSON.parse(raw) : null, updatedAt: s.getRange("B2").getValue() || null };
}
function cacheConfig(text, updatedAt) {
  const cache = CacheService.getScriptCache();
  const parts = {}; let n = 0;
  for (let i = 0; i < text.length; i += CACHE_CHUNK) parts["cfg:" + (n++)] = text.slice(i, i + CACHE_CHUNK);
  parts["cfg:n"] = String(n); parts["cfg:at"] = String(updatedAt || "");
  try { cache.putAll(parts, SESSION_TTL); } catch (e) { /* too big to cache: the sheet is still the source */ }
}
let _cfgMemo = null;
function getConfig() {
  if (_cfgMemo) return _cfgMemo;
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get("cfg:n") || 0);
  if (n) {
    const keys = []; for (let i = 0; i < n; i++) keys.push("cfg:" + i);
    const got = cache.getAll(keys);
    if (keys.every(k => typeof got[k] === "string")) {
      try { _cfgMemo = { config: JSON.parse(keys.map(k => got[k]).join("")), updatedAt: cache.get("cfg:at") || null }; return _cfgMemo; } catch (e) {}
    }
  }
  const fromSheet = readConfigFromSheet();
  if (fromSheet.config) { cacheConfig(JSON.stringify(fromSheet.config), fromSheet.updatedAt); _cfgMemo = fromSheet; }
  return fromSheet;
}

/* ---------- what learners are allowed to see ---------- */
const COURSE_FIELDS = ["courseTitle", "intro", "doneTitle", "doneNote", "requireFullWatch", "lockPlayback", "requireAllCorrect",
  "revealCorrect", "captionsOn", "reviewEnabled", "reviewTitle", "reviewPrompt", "languages", "closesAt", "closedTitle", "closedNote"];
// Deadline: after cfg.closesAt (an ISO time set in the dashboard) nobody can sign in or submit a section.
// cfg.graceMinutes lets people who had already signed in keep going a little longer (0 = hard stop).
// The end-of-course review is still accepted after the deadline, since the learner's completion was already recorded.
function isClosed(cfg, alreadyStarted) {
  const t = Date.parse(cfg && cfg.closesAt || "");
  if (!t) return false;
  const grace = alreadyStarted ? Math.max(0, Number(cfg.graceMinutes) || 0) * 60000 : 0;
  return Date.now() >= t + grace;
}
function pickTranslations(cfg, test) {
  const out = {};
  Object.keys(cfg.translations || {}).forEach(lang => {
    const src = cfg.translations[lang] || {}, dst = {};
    Object.keys(src).forEach(k => { if (test(k)) dst[k] = src[k]; });
    out[lang] = dst;
  });
  return out;
}
function publicShell(cfg) {
  const shell = { count: (cfg.segments || []).length };
  COURSE_FIELDS.forEach(f => { if (f in cfg) shell[f] = cfg[f]; });
  shell.translations = pickTranslations(cfg, k => /^(c|ui):/.test(k));
  shell.closed = isClosed(cfg, false);
  return shell;
}
function publicSection(cfg, i) {
  const seg = cfg.segments[i]; if (!seg) return null;
  const out = JSON.parse(JSON.stringify(seg));
  delete out._driveTooBig; delete out._vimeoUnresolved;
  out.questions = (seg.noQuiz ? [] : (seg.questions || [])).map(q => ({ id: q.id, q: q.q, options: q.options }));   // no answers
  const ids = new Set([seg.id].concat((seg.questions || []).map(q => q.id), (seg.images || []).map(im => im.id)));
  out.tx = pickTranslations(cfg, k => { const m = k.match(/^(?:s|q|i|cap):([^:]+)/); return !!m && ids.has(m[1]); });
  return out;
}

/* ---------- learner sessions (cache, 6 hours) ---------- */
function getSession(token) {
  if (!token || typeof token !== "string") return null;
  const raw = CacheService.getScriptCache().get("s:" + token);
  return raw ? JSON.parse(raw) : null;
}
function putSession(token, s) { CacheService.getScriptCache().put("s:" + token, JSON.stringify(s), SESSION_TTL); }

/* ---------- sheet writes: appendRow is atomic, so no script-wide lock is needed per row ---------- */
function ensureHeader(sh, cols) {
  if (sh.getLastRow() > 0 && sh.getLastColumn() >= cols.length) return;
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (sh.getLastRow() === 0) { sh.appendRow(cols); sh.getRange(1, 1, 1, cols.length).setFontWeight("bold"); sh.setFrozenRows(1); }
    else if (sh.getLastColumn() < cols.length) sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight("bold");
  } finally { lock.releaseLock(); }
}
// The Submissions sheet: SUB_BASE + "Section 1"…"Section n". A sheet in the older one-row-per-attempt
// layout is renamed "Submissions (old format)" (nothing deleted) and a fresh one started.
function completionSheet(n) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SUB_SHEET);
  const want = k => SUB_BASE.concat(Array.from({ length: k }, (_, i) => "Section " + (i + 1)));
  if (sh && sh.getLastRow() > 0) {
    const w = sh.getLastColumn(), head = sh.getRange(1, 1, 1, w).getValues()[0].map(String);
    const fits = SUB_BASE.every((c, k) => head[k] === c);
    const have = head.filter(h => /^Section \d+$/.test(h)).length;
    if (fits && have >= n) return sh;
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      if (!fits && sh.getLastRow() > 1) {
        let name = SUB_SHEET + " (old format)"; for (let k = 2; ss.getSheetByName(name); k++) name = SUB_SHEET + " (old format " + k + ")";
        sh.setName(name); sh = ss.insertSheet(SUB_SHEET);
      } else {
        const cols = want(fits ? Math.max(n, have) : n);
        sh.getRange(1, 1, 1, Math.max(w, cols.length)).clearContent();
        sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight("bold");
        return sh;
      }
    } finally { lock.releaseLock(); }
  }
  sh = sh || ss.insertSheet(SUB_SHEET);
  ensureHeader(sh, want(n));
  return sh;
}
function sectionResult(seg, r) {
  if (!r) return (seg.title || "") + " — completed";
  const mins = r.sec != null ? " · " + Math.max(1, Math.round(r.sec / 60)) + " min" : "";
  if (!r.t) return (seg.title || "") + " — Viewed" + mins;
  const tries = r.a === 1 ? "1st try" : r.a + " tries";
  return (seg.title || "") + " — Passed " + r.c + "/" + r.t + " · " + tries + mins;
}
function writeCompletion(cfg, s, now) {
  const segs = cfg.segments, n = segs.length, sh = completionSheet(n);
  const t0 = s.t0 || (s.dl && s.dl[0]) || now.getTime();
  let retries = 0; for (let i = 0; i < n; i++) retries += Math.max(0, ((s.att || {})[i] || 1) - 1);
  const row = {
    submittedAt: now.toISOString(), submittedAtLocal: localStamp(now),
    studentFirst: s.sf !== undefined ? s.sf : s.student, studentLast: s.sl || "", parentFirst: s.pf !== undefined ? s.pf : s.name, parentLast: s.pl || "",
    email: s.email, parentId: s.pid || "", qualifyingFirst: s.qf !== undefined ? s.qf : s.qualifying, qualifyingLast: s.ql || "",
    course: cfg.courseTitle, language: s.lang, minutes: Math.round((now.getTime() - t0) / 60000), retries: retries
  };
  const vals = SUB_FIELDS.map(f => row[f[0]]).concat(segs.map((seg, i) => sectionResult(seg, (s.res || {})[i]))).map(cellSafe);
  vals[SUB_FIELDS.findIndex(f => f[0] === "parentId")] = asText(row.parentId);
  sh.appendRow(vals);
}
function appendRow(name, cols, row) {
  const sh = sheet(name); ensureHeader(sh, cols);
  sh.appendRow(cols.map(k => k === "parentId" ? asText(String(row[k] || "")) : cellSafe((k in row) ? row[k] : "")));
}
function localStamp(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "M/d/yyyy, h:mm:ss a"); }

/* ---------- GET ---------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === "version") return json({ ok: true, version: BACKEND_VERSION });
  if (p.action === "shell") {
    const c = getConfig();
    return json(c.config ? { ok: true, shell: publicShell(c.config), updatedAt: c.updatedAt } : { ok: false, error: "not_published" });
  }
  return ContentService.createTextOutput("Course backend is running.");
}

/* ---------- POST ---------- */
function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: "Bad request" }); }
  try {
    switch (data.action) {
      /* learners */
      case "start":   return json(startSession(data));
      case "resume":  return json(resumeSession(data));
      case "answer":  return json(gradeAnswer(data));
      case "review":  return json(saveReview(data));

      /* admin */
      case "checkKey": return json({ ok: isAdmin(data.key) });
      case "getConfig": {
        if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
        const c = readConfigFromSheet();
        return json({ ok: true, config: c.config, updatedAt: c.updatedAt });
      }
      case "saveConfig": return json(saveConfig(data));
      case "listSubmissions": case "listReviews": {
        if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
        const subs = data.action === "listSubmissions", s = sheet(subs ? SUB_SHEET : REVIEW_SHEET);
        let cols = REVIEW_COLUMNS;
        if (subs) cols = s.getLastRow() > 0 ? s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(String).filter(Boolean) : SUB_BASE;
        const rows = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, cols.length).getValues() : [];
        return json({ ok: true, columns: cols, rows: rows });
      }
      case "translate": {
        if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
        return json({ ok: true, results: translateItems(data.items || [], data.source || "en", String(data.target || "")) });
      }
      case "driveFileInfo": {
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
      case "uploadImage": {
        // Saved to a Drive folder next to this sheet, shared read-only by link, served back as a direct image URL.
        if (!isAdmin(data.key)) return json({ ok: false, error: "Unauthorized" });
        if (!data.data || !/^image\//.test(data.mime || "")) return json({ ok: false, error: "Not an image" });
        const safeName = String(data.name || "image").replace(/[^\w.\-]+/g, "_").slice(0, 80);
        const file = imageFolder().createFile(Utilities.newBlob(Utilities.base64Decode(data.data), data.mime, safeName));
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        return json({ ok: true, id: file.getId(), url: "https://lh3.googleusercontent.com/d/" + file.getId(), name: file.getName() });
      }
    }
    return json({ ok: false, error: "Unknown request" });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function saveConfig(data) {
  if (!isAdmin(data.key)) return { ok: false, error: "Unauthorized" };
  if (!data.config || !Array.isArray(data.config.segments)) return { ok: false, error: "Invalid config" };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const s = sheet(CFG_SHEET);
    if (s.getLastRow() === 0) { s.appendRow(["courseJson", "updatedAt"]); s.getRange(1,1,1,2).setFontWeight("bold"); }
    const now = new Date().toISOString();
    const text = JSON.stringify(data.config);
    const parts = [];
    for (let i = 0; i < text.length; i += CHUNK) parts.push([text.slice(i, i + CHUNK)]);
    if (s.getLastRow() >= 2) s.getRange(2, 1, s.getLastRow() - 1, 2).clearContent();
    s.getRange(2, 1, parts.length, 1).setNumberFormat("@").setValues(parts);
    s.getRange("B2").setValue(now);
    cacheConfig(text, now);   // learners get the new version straight away
    _cfgMemo = null;
    return { ok: true, updatedAt: now, cells: parts.length };
  } finally { lock.releaseLock(); }
}

/* ---------- learner flow ---------- */
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max || 200);
// Older course pages send whole names only; split at the last space so those learners still get a row.
function splitName(full) { const t = str(full).replace(/\s+/g, " "), k = t.lastIndexOf(" "); return k > 0 ? [t.slice(0, k), t.slice(k + 1)] : [t, ""]; }
function startSession(d) {
  const cfg = getConfig().config;
  if (!cfg || !(cfg.segments || []).length) return { ok: false, error: "not_published" };
  if (isClosed(cfg, false)) return { ok: false, error: "closed" };
  const split = "parentFirst" in d;
  const [pf, pl] = split ? [str(d.parentFirst, 100), str(d.parentLast, 100)] : splitName(d.name);
  const [qf, ql] = split ? [str(d.qualifyingFirst, 100), str(d.qualifyingLast, 100)] : splitName(d.qualifying);
  const [sf, sl] = split ? [str(d.studentFirst, 100), str(d.studentLast, 100)] : splitName(d.student);
  const email = str(d.email), pid = str(d.parentId, 40);
  if (!pf || !qf || !sf || (split && (!pl || !ql || !sl || !pid)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "missing_fields" };
  const join = (a, b) => (a + " " + b).trim();
  const token = Utilities.getUuid();
  const now = Date.now();
  putSession(token, { pf, pl, qf, ql, sf, sl, pid, name: join(pf, pl), email, qualifying: join(qf, ql), student: join(sf, sl),
                      lang: str(d.lang, 10) || "en", p: 0, att: {}, dl: { 0: now }, res: {}, t0: now, rev: false });
  return { ok: true, token, progress: 0, count: cfg.segments.length, section: publicSection(cfg, 0) };
}
function resumeSession(d) {
  const s = getSession(d.token); if (!s) return { ok: false, error: "expired" };
  const cfg = getConfig().config; if (!cfg) return { ok: false, error: "not_published" };
  const count = cfg.segments.length;
  if (s.p < count && isClosed(cfg, true)) return { ok: false, error: "closed" };
  if (s.p < count) { s.dl[s.p] = s.dl[s.p] || Date.now(); putSession(d.token, s); }
  const person = s.pf !== undefined ? { pFirst: s.pf, pLast: s.pl, email: s.email, parentId: s.pid, qFirst: s.qf, qLast: s.ql, sFirst: s.sf, sLast: s.sl } : null;
  return { ok: true, progress: s.p, count, name: s.name, email: s.email, qualifying: s.qualifying, student: s.student, person, reviewed: !!s.rev,
           section: s.p < count ? publicSection(cfg, s.p) : null };
}
function gradeAnswer(d) {
  const s = getSession(d.token); if (!s) return { ok: false, error: "expired" };
  const cfg = getConfig().config; if (!cfg) return { ok: false, error: "not_published" };
  const i = Number(d.index), count = cfg.segments.length;
  if (isClosed(cfg, true)) return { ok: false, error: "closed" };
  if (i !== s.p || i >= count) return { ok: false, error: "out_of_order", progress: s.p };
  const seg = cfg.segments[i];
  const questions = seg.noQuiz ? [] : (seg.questions || []);
  const answers = Array.isArray(d.answers) ? d.answers.map(Number) : [];
  const results = questions.map((q, k) => answers[k] === q.answer);
  const correct = results.filter(Boolean).length, total = questions.length;
  const passed = !questions.length || cfg.requireAllCorrect === false || correct === total;
  s.att[i] = (s.att[i] || 0) + 1;
  if (d.lang) s.lang = str(d.lang, 10);
  const now = new Date();
  if (passed) {
    s.res = s.res || {};
    s.res[i] = { c: correct, t: total, a: s.att[i], sec: s.dl[i] ? Math.round((now.getTime() - s.dl[i]) / 1000) : null };
    s.p = i + 1; if (s.p < count) s.dl[s.p] = now.getTime();
    if (s.p >= count) writeCompletion(cfg, s, now);   // the only Submissions row for this learner
  }
  putSession(d.token, s);
  const out = { ok: true, passed, correct, total, results, completed: passed && s.p >= count,
                next: passed && s.p < count ? publicSection(cfg, s.p) : null };
  if (!passed && cfg.revealCorrect) out.reveal = questions.map(q => q.answer);   // admin chose to show answers after a miss
  return out;
}
function saveReview(d) {
  const s = getSession(d.token); if (!s) return { ok: false, error: "expired" };
  const cfg = getConfig().config; if (!cfg) return { ok: false, error: "not_published" };
  if (s.p < cfg.segments.length) return { ok: false, error: "not_finished" };
  if (s.rev) return { ok: true, duplicate: true };
  const rating = Number(d.rating);
  if (!(rating >= 1 && rating <= 5 && Math.round(rating) === rating)) return { ok: false, error: "Rating must be 1–5" };
  const now = new Date();
  appendRow(REVIEW_SHEET, REVIEW_COLUMNS, {
    submittedAt: now.toISOString(), submittedAtLocal: localStamp(now), name: s.name, email: s.email, course: cfg.courseTitle,
    rating: rating, comment: str(d.comment, 2000), language: str(d.lang, 10) || s.lang, qualifyingParent: s.qualifying, studentName: s.student,
    parentId: s.pid || ""
  });
  s.rev = true; putSession(d.token, s);
  return { ok: true };
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
