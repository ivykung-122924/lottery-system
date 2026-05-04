const express = require('express');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const fs = require('fs');
const app = express();

// 1. 路徑與資料庫初始化
let publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) publicPath = path.join(__dirname, '..', 'public');

const db = new Database('lottery.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    name TEXT, 
    phone TEXT, 
    count INTEGER, 
    importDate TEXT,
    orderId TEXT,
    amount TEXT
)`);

app.use(express.json());
app.use(express.static(publicPath));
const upload = multer({ storage: multer.memoryStorage() });

// --- 關鍵修復：恢復健康檢查接口 ---
// 這將解決 Railway 部署時的 "service unavailable" 錯誤
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// 2. 獲取最新結算日期 API
app.get('/api/latest-date', (req, res) => {
    try {
        const row = db.prepare('SELECT importDate FROM users ORDER BY importDate DESC LIMIT 1').get();
        res.json({ latestDate: row ? row.importDate : "暫無資料" });
    } catch (err) { 
        res.status(500).json({ error: "讀取日期失敗" }); 
    }
});

// 3. 後台日誌 API
app.get('/api/admin/logs', (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    try {
        const logs = db.prepare('SELECT importDate, COUNT(*) as total FROM users GROUP BY importDate ORDER BY importDate DESC').all();
        res.json(logs);
    } catch (err) { res.status(500).json({ error: "讀取日誌失敗" }); }
});

// 4. 前台查詢 API
app.get('/api/check', (req, res) => {
    try {
        const phone = String(req.query.phone || "").trim();
        if (!phone) return res.json({ found: false });
        const details = db.prepare('SELECT * FROM users WHERE phone = ?').all(phone);
        if (details.length > 0) {
            const totalCount = details.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
            res.json({ found: true, name: details[0].name, totalCount: totalCount, details: details });
        } else { res.json({ found: false }); }
    } catch (err) { res.status(500).json({ error: "查詢出錯" }); }
});

// 5. 後台匯入 API
app.post('/api/admin/import-replace-date', upload.single('file'), (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const today = new Date().toISOString().split('T')[0];
        let successCount = 0;

        const runImport = db.transaction((rows) => {
            const datesInExcel = [...new Set(rows.map(r => String(r['日期'] || today).trim()))];
            if (req.query.mode === 'replace') {
                const deleteStmt = db.prepare('DELETE FROM users WHERE importDate = ?');
                for (const d of datesInExcel) deleteStmt.run(d);
            }
            const insertStmt = db.prepare('INSERT INTO users (name, phone, count, importDate, orderId, amount) VALUES (?, ?, ?, ?, ?, ?)');
            for (const row of rows) {
                const name = row['姓名'], orderId = row['訂單編號'] || "無", amount = row['金額'] || "0", importDate = String(row['日期'] || today).trim(), count = parseInt(row['抽獎次數'] || 1);
                let phone = String(row['電話'] || "").trim();
                if (name && phone) {
                    if (phone.length === 9 && phone.startsWith('9')) phone = '0' + phone;
                    insertStmt.run(String(name), phone, isNaN(count) ? 1 : count, importDate, String(orderId), String(amount));
                    successCount++;
                }
            }
        });
        runImport(data);
        res.json({ ok: true, inserted: successCount });
    } catch (err) { res.status(500).json({ error: "匯入失敗" }); }
});

// 6. 頁面路由
app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// 7. 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${PORT}`);
});
