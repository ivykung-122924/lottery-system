import express from "express";
import sqlite from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse/sync";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// --- 管理員密碼 ---
const ADMIN_PASSWORD = "123456"; 

const db = sqlite("database.db");
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// --- 路由設定 ---
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/admin.html"));
});

// --- 初始化資料庫 ---
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    date TEXT,
    amount REAL,
    orderId TEXT,
    customerId TEXT,
    note TEXT,
    source TEXT,
    createdAt TEXT,
    importId INTEGER
  );
  CREATE TABLE IF NOT EXISTS import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uploadedAt TEXT,
    mode TEXT,
    format TEXT,
    originalName TEXT,
    rowsInserted INTEGER,
    rowsRejected INTEGER
  );
`);

// --- 工具函式 ---
function normalizePhone(p) {
  return String(p || "").replace(/\D/g, "");
}

function excelDateToISO(val) {
  if (!val) return "";
  if (val instanceof Date) return val.toISOString().split("T")[0];
  const d = new Date(val);
  return isNaN(d.getTime()) ? String(val).trim() : d.toISOString().split("T")[0];
}

function pickValue(row, keys) {
  const foundKey = Object.keys(row).find(k => {
    const s = k.toLowerCase().trim();
    return keys.includes(s) || keys.includes(k.trim());
  });
  return foundKey ? row[foundKey] : "";
}

function adminAuth(req, res, next) {
  const provided = req.header("x-admin-password") || "";
  if (provided === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: "UNAUTHORIZED" });
}

// --- API 路由 ---

app.get("/api/check", (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json({ found: false });
    const cleanPhone = normalizePhone(phone);
    const rows = db.prepare("SELECT * FROM entries WHERE phone = ? ORDER BY date DESC").all(cleanPhone);
    if (rows.length > 0) res.json({ found: true, count: rows.length, data: rows });
    else res.json({ found: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/import-history", adminAuth, (req, res) => {
  try {
    const runs = db.prepare(`SELECT * FROM import_runs ORDER BY id DESC LIMIT 15`).all();
    res.json(runs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function handleImport(req, res, mode) {
  try {
    if (!req.file) return res.status(400).json({ error: "NO_FILE" });
    const isXlsx = req.file.originalname.endsWith(".xlsx");
    const rawRows = isXlsx 
      ? XLSX.utils.sheet_to_json(XLSX.read(req.file.buffer, { type: "buffer", cellDates: true }).Sheets[XLSX.read(req.file.buffer).SheetNames[0]], { defval: "" })
      : parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true });

    const validRows = [];
    rawRows.forEach(r => {
      const name = String(pickValue(r, ["name", "姓名", "客戶姓名"]) || "").trim();
      const phone = normalizePhone(pickValue(r, ["phone", "電話", "手機"]));
      if (name && phone) {
        validRows.push({
          name, phone,
          date: excelDateToISO(pickValue(r, ["date", "日期", "交易日期"])),
          amount: Number(String(pickValue(r, ["amount", "金額"]) || 0).replace(/,/g, '')),
          orderId: String(pickValue(r, ["orderId", "訂單編號", "單號"]) || "").trim()
        });
      }
    });

    const tx = db.transaction((data) => {
      if (mode === "replace") {
        const dates = [...new Set(data.map(r => r.date))].filter(d => d);
        const del = db.prepare(`DELETE FROM entries WHERE date = ?`);
        dates.forEach(d => del.run(d));
      }
      const run = db.prepare(`INSERT INTO import_runs (uploadedAt, mode, format, originalName, rowsInserted, rowsRejected) VALUES (?,?,?,?,?,?)`)
                    .run(new Date().toLocaleString('zh-TW'), mode, isXlsx?"xlsx":"csv", req.file.originalname, data.length, 0);
      const ins = db.prepare(`INSERT INTO entries (name, phone, date, amount, orderId, source, createdAt, importId) VALUES (?,?,?,?,?,?,?,?)`);
      for (const r of data) {
        ins.run(r.name, r.phone, r.date, r.amount, r.orderId, mode, new Date().toISOString(), run.lastInsertRowid);
      }
      return data.length;
    });

    const inserted = tx(validRows);
    res.json({ ok: true, inserted });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

app.post("/api/admin/import-append", adminAuth, upload.single("file"), (req, res) => handleImport(req, res, "append"));
app.post("/api/admin/import-replace-date", adminAuth, upload.single("file"), (req, res) => handleImport(req, res, "replace"));

// --- 修正：適應 Railway 的 PORT 設定與 0.0.0.0 監聽 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n=========================================`);
  console.log(`🚀 伺服器已在 Railway/本地 啟動成功！`);
  console.log(`👉 連接埠: ${PORT}`);
  console.log(`=========================================\n`);
});