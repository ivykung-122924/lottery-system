const express = require('express');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const fs = require('fs');
const app = express();

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

app.get('/health', (req, res) => res.status(200).send('OK'));

// 後台清單 API
app.get('/api/admin/list', (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    try {
        const rows = db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 500').all();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: "讀取失敗" }); }
});

// 前台查詢 API
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

// 核心匯入邏輯
app.post('/api/admin/import-replace-date', upload.single('file'), (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    if (!req.file) return res.status(400).json({ error: '請選擇檔案' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const today = new Date().toISOString().split('T')[0];
        let successCount = 0;

        const runImport = db.transaction((rows) => {
            // 如果是替換模式，刪除今天日期的資料
            if (req.query.mode === 'replace') db.prepare('DELETE FROM users WHERE importDate = ?').run(today);
            
            const insertStmt = db.prepare('INSERT INTO users (name, phone, count, importDate, orderId, amount) VALUES (?, ?, ?, ?, ?, ?)');
            
            for (const row of rows) {
                // 根據你提供的圖片，精準對應標題名稱
                const name = row['姓名'];
                let phone = String(row['電話'] || "").trim();
                const orderId = row['訂單編號'] || "無";
                const amount = row['金額'] || "0";
                
                // 如果 Excel 有日期欄位就用 Excel 的，沒有就用今天的日期
                const importDate = row['日期'] || today;
                
                // 抽獎次數：預設 1 次，如果 Excel 有寫就用 Excel 的
                const count = parseInt(row['抽獎次數'] || 1);

                if (name && phone) {
                    // 自動補 0 處理
                    if (phone.length === 9 && phone.startsWith('9')) phone = '0' + phone;
                    
                    insertStmt.run(
                        String(name), 
                        phone, 
                        isNaN(count) ? 1 : count, 
                        String(importDate), 
                        String(orderId), 
                        String(amount)
                    );
                    successCount++;
                }
            }
        });

        runImport(data);
        res.json({ ok: true, inserted: successCount, totalInFile: data.length });
    } catch (err) {
        console.error("匯入出錯:", err);
        res.status(500).json({ error: "資料格式不符，請檢查 Excel 標題是否為：姓名、電話、日期、訂單編號、金額" });
    }
});

app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.listen(process.env.PORT || 3000, "0.0.0.0");
