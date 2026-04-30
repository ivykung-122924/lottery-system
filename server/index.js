import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";
import * as XLSX from "xlsx";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: "server/.env" });

const app = express();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.use(express.static(path.join(__dirname, "../public")));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const ROOT = path.resolve(process.cwd());
const DATA_DIR = path.join(ROOT, "data", "uploads");
const LATEST_JSON = path.join(DATA_DIR, "latest.json");
const DB_PATH = path.join(ROOT, "data", "app.sqlite");
const PUBLIC_UPLOADS_DIR = path.join(ROOT, "public", "uploads");
const BANNER_META = path.join(PUBLIC_UPLOADS_DIR, "banner.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_UPLOADS_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "../public")));

function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("886") && digits.length >= 11) {
    // 8869xxxxxxxx -> 09xxxxxxxx
    return "0" + digits.slice(3);
  }
  if (digits.length === 9 && digits.startsWith("9")) return "0" + digits;
  return digits;
}

function normalizeName(raw) {
  return String(raw ?? "")
    .replace(/\u3000/g, " ") // full-width space
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars
    .trim()
    .replace(/\s+/g, " ");
}

function nameKey(name) {
  return normalizeName(name).replace(/\s+/g, "");
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    nameKey TEXT NOT NULL,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    amount REAL,
    note TEXT,
    customerId TEXT,
    createdAt TEXT NOT NULL,
    importId INTEGER,
    rowHash TEXT NOT NULL UNIQUE
  );

  CREATE INDEX IF NOT EXISTS idx_entries_lookup ON entries (nameKey, phone, date);
  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries (date);

  CREATE TABLE IF NOT EXISTS import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uploadedAt TEXT NOT NULL,
    mode TEXT NOT NULL,
    format TEXT NOT NULL,
    originalName TEXT,
    fileSha256 TEXT,
    rowsInserted INTEGER NOT NULL,
    rowsRejected INTEGER NOT NULL,
    minDate TEXT,
    maxDate TEXT
  );
`);
const entryColumns = db.prepare(`PRAGMA table_info(entries)`).all();
if (!entryColumns.some((c) => c.name === "orderId")) {
  db.exec(`ALTER TABLE entries ADD COLUMN orderId TEXT`);
}

function maskName(name) {
  const s = normalizeName(name);
  if (s.length <= 1) return s;
  if (s.length === 2) return `${s[0]}○`;
  return `${s[0]}${"○".repeat(s.length - 2)}${s[s.length - 1]}`;
}

function maskPhone(phone) {
  const p = normalizePhone(phone);
  const last3 = p.slice(-3);
  return `${"*".repeat(Math.max(0, p.length - 3))}${last3}`;
}

function safeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function safeNumberOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseDateISO(v) {
  const s = String(v ?? "").trim();
  // accept YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function excelDateToISO(v) {
  // Accept:
  // - Date object
  // - number (Excel serial)
  // - string "YYYY-MM-DD" or "YYYY/MM/DD"
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d || !d.y || !d.m || !d.d) return null;
    const yyyy = String(d.y).padStart(4, "0");
    const mm = String(d.m).padStart(2, "0");
    const dd = String(d.d).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("/");
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return parseDateISO(s);
}

function pickValue(row, keys) {
  for (const k of keys) {
    if (row && Object.prototype.hasOwnProperty.call(row, k)) return row[k];
  }
  return undefined;
}

function normalizeUploadRows(rawRows, { sourceLabel }) {
  const rows = [];
  const errors = [];

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];

    // Support both EN and ZH headers
    const name = normalizeName(
      pickValue(r, ["name", "姓名", "客戶姓名", "會員姓名", "客戶名稱", "姓名(中文)", "中文姓名"])
    );
    const phone = normalizePhone(
      pickValue(r, ["phone", "電話", "手機", "手機號碼", "電話號碼", "手機電話", "聯絡電話", "聯絡手機"])
    );
    const date = excelDateToISO(
      pickValue(r, ["date", "日期", "交易日期", "交易日", "消費日期", "消費日", "購買日期", "訂單日期"])
    );
    const amount = safeNumberOrNull(
      pickValue(r, ["amount", "消費金額", "金額", "消費額", "交易金額"])
    );
    const customerIdRaw = pickValue(r, ["customerId", "客戶編號", "客編", "會員編號"]);
    const orderIdRaw = pickValue(r, ["orderId", "orderNo", "訂單編號", "訂單號碼", "訂單號"]);
    const noteRaw = pickValue(r, ["note", "備註", "說明"]);

    // header row is 1 in Excel/CSV, but we report with +2 as before
    const rowNum = i + 2;

    if (!name) errors.push({ row: rowNum, field: "name", message: "必填" });
    if (!phone) errors.push({ row: rowNum, field: "phone", message: "必填（只留數字）" });
    if (!date) errors.push({ row: rowNum, field: "date", message: "必填（格式 YYYY-MM-DD）" });

    // 抽獎機會改為「以日為單位」：同一日最多一次，因此上傳不再需要次數欄位
    if (name && phone && date) {
      rows.push({
        name,
        phone,
        customerId: String(customerIdRaw ?? "").trim() || null,
        orderId: String(orderIdRaw ?? "").trim() || null,
        date,
        amount,
        note: String(noteRaw ?? "").trim() || null,
        source: sourceLabel || null
      });
    }
  }

  return { rows, errors };
}

function loadLatest() {
  if (!fs.existsSync(LATEST_JSON)) {
    return { uploadedAt: null, rows: [] };
  }
  const txt = fs.readFileSync(LATEST_JSON, "utf8");
  return JSON.parse(txt);
}

function saveLatest(payload) {
  fs.writeFileSync(LATEST_JSON, JSON.stringify(payload, null, 2), "utf8");
}

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      error: "ADMIN_PASSWORD_NOT_SET",
      message: "請先設定環境變數 ADMIN_PASSWORD 才能使用管理端功能。"
    });
  }
  const provided = req.header("x-admin-password") || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_PASSWORD);
  const ok =
    a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 } // 3MB
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/admin/upload-banner", adminAuth, uploadImage.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "NO_FILE" });
  const mime = String(req.file.mimetype || "").toLowerCase();
  if (!mime.startsWith("image/")) {
    return res.status(400).json({ error: "UNSUPPORTED_FILE", message: "請上傳圖片檔（image/*）" });
  }

  const extFromName = path.extname(String(req.file.originalname || "")).toLowerCase();
  const ext =
    [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extFromName) ? extFromName : ".png";

  const filename = `banner${ext}`;
  const abs = path.join(PUBLIC_UPLOADS_DIR, filename);
  fs.writeFileSync(abs, req.file.buffer);
  fs.writeFileSync(BANNER_META, JSON.stringify({ filename, uploadedAt: new Date().toISOString() }, null, 2), "utf8");

  res.json({ ok: true, filename });
});

function detectFormat(reqFile) {
  const filename = String(reqFile?.originalname || "").toLowerCase();
  const isXlsx =
    filename.endsWith(".xlsx") ||
    reqFile?.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const isCsv =
    filename.endsWith(".csv") ||
    reqFile?.mimetype === "text/csv" ||
    reqFile?.mimetype === "application/vnd.ms-excel";
  return { isXlsx, isCsv };
}

function parseUploadFile(reqFile) {
  const { isXlsx, isCsv } = detectFormat(reqFile);
  if (isXlsx) {
    const wb = XLSX.read(reqFile.buffer, { type: "buffer", cellDates: true });
    const sheetName = wb.SheetNames?.[0];
    if (!sheetName) throw new Error("XLSX_NO_SHEET");
    const ws = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    return { rawRows, format: "xlsx" };
  }
  if (isCsv) {
    const rawRows = parseCsv(reqFile.buffer, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true
    });
    return { rawRows, format: "csv" };
  }
  const err = new Error("UNSUPPORTED_FILE");
  err.code = "UNSUPPORTED_FILE";
  throw err;
}

const insertEntryStmt = db.prepare(`
  INSERT INTO entries
    (name, nameKey, phone, date, amount, note, customerId, orderId, createdAt, importId, rowHash)
  VALUES
    (@name, @nameKey, @phone, @date, @amount, @note, @customerId, @orderId, @createdAt, @importId, @rowHash)
`);

const insertImportRunStmt = db.prepare(`
  INSERT INTO import_runs
    (uploadedAt, mode, format, originalName, fileSha256, rowsInserted, rowsRejected, minDate, maxDate)
  VALUES
    (@uploadedAt, @mode, @format, @originalName, @fileSha256, @rowsInserted, @rowsRejected, @minDate, @maxDate)
`);

function entryRowHash(e) {
  return sha256Hex(
    Buffer.from(
      `${e.nameKey}|${e.phone}|${e.date}|${e.amount ?? ""}|${e.customerId ?? ""}|${e.orderId ?? ""}|${e.note ?? ""}`,
      "utf8"
    )
  );
}

function importRowsToDb({ rows, mode, format, originalName, fileSha256, replaceDates }) {
  const nowIso = new Date().toISOString();
  const dates = rows.map((r) => r.date).sort();
  const minDate = dates.length ? dates[0] : null;
  const maxDate = dates.length ? dates[dates.length - 1] : null;

  const tx = db.transaction(() => {
    if (mode === "replace_dates" && Array.isArray(replaceDates) && replaceDates.length) {
      const del = db.prepare(`DELETE FROM entries WHERE date = ?`);
      for (const d of replaceDates) del.run(d);
    }

    const runInfo = insertImportRunStmt.run({
      uploadedAt: nowIso,
      mode,
      format,
      originalName: originalName || null,
      fileSha256: fileSha256 || null,
      rowsInserted: 0,
      rowsRejected: 0,
      minDate,
      maxDate
    });

    let inserted = 0;
    let rejected = 0;
    for (const r of rows) {
      const nk = nameKey(r.name);
      const ph = normalizePhone(r.phone);
      const rowHash = entryRowHash({
        nameKey: nk,
        phone: ph,
        date: r.date,
        amount: typeof r.amount === "number" ? r.amount : null,
        note: r.note ?? null,
        customerId: r.customerId ?? null,
        orderId: r.orderId ?? null
      });

      try {
        insertEntryStmt.run({
          name: r.name,
          nameKey: nk,
          phone: ph,
          date: r.date,
          amount: typeof r.amount === "number" ? r.amount : null,
          note: r.note ?? null,
          customerId: r.customerId ?? null,
          orderId: r.orderId ?? null,
          createdAt: nowIso,
          importId: runInfo.lastInsertRowid,
          rowHash
        });
        inserted++;
      } catch {
        rejected++;
      }
    }

    db.prepare(`UPDATE import_runs SET rowsInserted = ?, rowsRejected = ? WHERE id = ?`).run(
      inserted,
      rejected,
      runInfo.lastInsertRowid
    );

    return { importRunId: runInfo.lastInsertRowid, inserted, rejected, minDate, maxDate };
  });

  return tx();
}

app.get("/api/admin/import-runs", adminAuth, (req, res) => {
  const runs = db
    .prepare(
      `SELECT id, uploadedAt, mode, format, originalName, rowsInserted, rowsRejected, minDate, maxDate
       FROM import_runs
       ORDER BY id DESC
       LIMIT 50`
    )
    .all();
  res.json({ ok: true, runs });
});

app.get("/api/admin/dates", adminAuth, (req, res) => {
  const dates = db
    .prepare(
      `SELECT date, COUNT(*) AS rows
       FROM entries
       GROUP BY date
       ORDER BY date DESC
       LIMIT 5000`
    )
    .all();
  res.json({ ok: true, dates });
});

app.post("/api/admin/delete-date", adminAuth, (req, res) => {
  const date = String(req.body?.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "INVALID_DATE" });
  const info = db.prepare(`DELETE FROM entries WHERE date = ?`).run(date);
  res.json({ ok: true, deletedRows: info.changes, date });
});

app.post("/api/admin/import-append", adminAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "NO_FILE" });
  let parsed;
  try {
    parsed = parseUploadFile(req.file);
  } catch (e) {
    if (e?.code === "UNSUPPORTED_FILE" || String(e?.message).includes("UNSUPPORTED_FILE")) {
      return res.status(400).json({ error: "UNSUPPORTED_FILE", message: "僅支援 .xlsx 或 .csv" });
    }
    return res.status(400).json({ error: "PARSE_FAILED", message: String(e?.message || e) });
  }

  const { rows, errors } = normalizeUploadRows(parsed.rawRows, { sourceLabel: parsed.format });
  if (errors.length) return res.status(400).json({ error: "VALIDATION_FAILED", errors });

  const result = importRowsToDb({
    rows,
    mode: "append",
    format: parsed.format,
    originalName: req.file.originalname,
    fileSha256: sha256Hex(req.file.buffer)
  });

  res.json({ ok: true, ...result });
});

app.post("/api/admin/import-replace-date", adminAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "NO_FILE" });
  const date = String(req.body?.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "INVALID_DATE" });

  let parsed;
  try {
    parsed = parseUploadFile(req.file);
  } catch (e) {
    if (e?.code === "UNSUPPORTED_FILE" || String(e?.message).includes("UNSUPPORTED_FILE")) {
      return res.status(400).json({ error: "UNSUPPORTED_FILE", message: "僅支援 .xlsx 或 .csv" });
    }
    return res.status(400).json({ error: "PARSE_FAILED", message: String(e?.message || e) });
  }

  const { rows, errors } = normalizeUploadRows(parsed.rawRows, { sourceLabel: parsed.format });
  if (errors.length) return res.status(400).json({ error: "VALIDATION_FAILED", errors });

  const filtered = rows.filter((r) => r.date === date);
  const result = importRowsToDb({
    rows: filtered,
    mode: "replace_dates",
    format: parsed.format,
    originalName: req.file.originalname,
    fileSha256: sha256Hex(req.file.buffer),
    replaceDates: [date]
  });

  res.json({ ok: true, replacedDate: date, importedForDate: filtered.length, ...result });
});

app.post("/api/admin/upload", adminAuth, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "NO_FILE" });
  }

  const filename = String(req.file.originalname || "").toLowerCase();
  const isXlsx = filename.endsWith(".xlsx") || req.file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const isCsv = filename.endsWith(".csv") || req.file.mimetype === "text/csv" || req.file.mimetype === "application/vnd.ms-excel";

  let rawRows;
  try {
    if (isXlsx) {
      const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      const sheetName = wb.SheetNames?.[0];
      if (!sheetName) return res.status(400).json({ error: "XLSX_NO_SHEET" });
      const ws = wb.Sheets[sheetName];
      rawRows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    } else if (isCsv) {
      rawRows = parseCsv(req.file.buffer, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true
      });
    } else {
      return res.status(400).json({ error: "UNSUPPORTED_FILE", message: "僅支援 .xlsx 或 .csv" });
    }
  } catch (e) {
    return res.status(400).json({ error: "PARSE_FAILED", message: String(e?.message || e) });
  }

  const { rows, errors } = normalizeUploadRows(rawRows, { sourceLabel: isXlsx ? "xlsx" : "csv" });
  if (errors.length) {
    return res.status(400).json({ error: "VALIDATION_FAILED", errors });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  saveLatest({ uploadedAt: new Date().toISOString(), rows });

  res.json({ ok: true, uploaded: rows.length, format: isXlsx ? "xlsx" : "csv" });
});

app.post("/api/admin/upload-csv", adminAuth, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "NO_FILE" });
  }

  let records;
  try {
    records = parseCsv(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true
    });
  } catch (e) {
    return res.status(400).json({ error: "CSV_PARSE_FAILED", message: String(e?.message || e) });
  }

  const { rows, errors } = normalizeUploadRows(records, { sourceLabel: "csv" });
  if (errors.length) return res.status(400).json({ error: "VALIDATION_FAILED", errors });

  rows.sort((a, b) => a.date.localeCompare(b.date));
  saveLatest({ uploadedAt: new Date().toISOString(), rows });

  res.json({ ok: true, uploaded: rows.length });
});

app.post("/api/lookup", (req, res) => {
  const phone = normalizePhone(req.body?.phone);

  if (!phone) {
    return res.status(400).json({ error: "MISSING_PHONE" });
  }

  const details = db
    .prepare(
      `WITH ranked AS (
         SELECT name,
                nameKey,
                phone,
                date,
                orderId,
                amount,
                note,
                importId,
                id,
                ROW_NUMBER() OVER (
                  PARTITION BY nameKey, phone, date
                  ORDER BY COALESCE(importId, 0) DESC, id DESC
                ) AS rn
         FROM entries
         WHERE phone = ?
       )
       SELECT name,
              date,
              1 AS chances,
              orderId,
              amount,
              note
       FROM ranked
       WHERE rn = 1
       ORDER BY date ASC, name ASC`
    )
    .all(phone);

  const total = details.length;
  const names = [...new Set(details.map((row) => String(row.name || "").trim()).filter(Boolean))];

  res.json({
    found: total > 0,
    display: {
      phone,
      names
    },
    totalChances: total,
    details
  });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "admin.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

