const express = require('express');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const fs = require('fs');
const app = express();

// 1. 自動偵測公用資料夾路徑 (解決 Railway 路徑層級問題)
let publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    publicPath = path.join(__dirname, '..', 'public');
}

// 2. 初始化資料庫
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

app.use(express.json());
app.use(express.static(publicPath));
const upload = multer({ storage: multer.memoryStorage() });

// 3. Railway 健康檢查
app.get('/health', (req, res) => res.status(200).send('OK'));

// --- 路由設定 ---

// 【前台】查詢 API
app.get('/api/check', (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.json({ found: false });
    // 統計同個電話的所有抽獎次數
    const row = db.prepare('SELECT name, SUM(count) as total FROM users WHERE phone = ?').get(phone);
    if (row && row.name) {
        res.json({ found: true, name: row.name, count: row.total });
    } else {
        res.json({ found: false });
    }
});

// 【後台】讀取最新 50 筆資料
app.get('/api/admin/list', (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    const rows = db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 50').all();
    res.json(rows);
});

// 【後台】匯入 Excel API (支援追加/替換)
app.post('/api/admin/import-replace-date', upload.single('file'), (req, res) => {
    const password = req.headers['x-admin-password'];
    const mode = req.query.mode || 'append'; // 預設為追加模式
    
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    if (!req.file) return res.status(400).json({ error: '未上傳檔案' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        const today = new Date().toISOString().split('T')[0];
        const deleteTodayStmt = db.prepare('DELETE FROM users WHERE importDate = ?');
        const insertStmt = db.prepare('INSERT INTO users (name, phone, count, importDate) VALUES (?, ?, ?, ?)');

        // 使用事務處理確保效能與穩定性
        const runImport = db.transaction((rows) => {
            if (mode === 'replace') {
                deleteTodayStmt.run(today); // 替換模式：先刪除今日舊資料
            }
            
            for (const row of rows) {
                const name = row.姓名 || row.Name || row.name;
                let phone = row.手機 || row.Phone || row.phone || row.電話;
                const count = parseInt(row.抽獎次數 || row.count || 1);

                if (name && phone) {
                    phone = String(phone).trim();
                    // 自動補 0 邏輯
                    if (phone.length === 9 && phone.startsWith('9')) {
                        phone = '0' + phone;
                    }
                    insertStmt.run(name, phone, count, today);
                }
            }
        });

        runImport(data);
        res.json({ ok: true, inserted: data.length });
    } catch (err) {
        console.error('匯入出錯:', err);
        res.status(500).json({ error: err.message });
    }
});

// 強制指向 HTML 檔案
app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// 4. 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 抽獎系統已啟動！Port: ${PORT}`);
    console.log(`📂 目前讀取路徑: ${publicPath}`);
});
