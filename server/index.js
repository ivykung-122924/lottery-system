const express = require('express');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const app = express();

// 1. 初始化資料庫 (在 Railway 環境會自動建立 lottery.db)
const db = new Database('lottery.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    count INTEGER,
    importDate TEXT
  )
`);

// 2. 基礎設定
app.use(express.json());
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));
const upload = multer({ storage: multer.memoryStorage() });

// 3. Railway 健康檢查 (必備)
app.get('/health', (req, res) => res.status(200).send('OK'));

// --- 路由設定 ---

// 前台查詢 API
app.get('/api/check', (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.json({ found: false });
    const row = db.prepare('SELECT name, SUM(count) as total FROM users WHERE phone = ?').get(phone);
    if (row && row.name) {
        res.json({ found: true, name: row.name, count: row.total });
    } else {
        res.json({ found: false });
    }
});

// 後台 Excel 匯入 API (密碼：123456)
app.post('/api/admin/import-replace-date', upload.single('file'), (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    if (!req.file) return res.status(400).json({ error: '未上傳檔案' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        // 清空舊資料並匯入新資料
        const deleteStmt = db.prepare('DELETE FROM users');
        const insertStmt = db.prepare('INSERT INTO users (name, phone, count, importDate) VALUES (?, ?, ?, ?)');
        
        const today = new Date().toISOString().split('T')[0];
        
        const transaction = db.transaction((rows) => {
            deleteStmt.run();
            for (const row of rows) {
                insertStmt.run(row.姓名, String(row.手機), row.抽獎次數 || 1, today);
            }
        });

        transaction(data);
        res.json({ ok: true, inserted: data.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 設定路徑讓網址列直接輸入 /admin 也能通
app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// 4. 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 抽獎系統運行中，Port: ${PORT}`);
});
