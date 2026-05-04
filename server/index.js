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
// 升級資料庫：加入訂單編號(orderId)與金額(amount)
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

// 【前台查詢：回傳總次數 + 所有明細】
app.get('/api/check', (req, res) => {
    try {
        const phone = req.query.phone;
        if (!phone) return res.json({ found: false });
        
        const details = db.prepare('SELECT * FROM users WHERE phone = ?').all(phone);
        
        if (details.length > 0) {
            const totalCount = details.reduce((sum, item) => sum + item.count, 0);
            res.json({ 
                found: true, 
                name: details[0].name, 
                totalCount: totalCount,
                details: details // 包含所有訂單明細
            });
        } else {
            res.json({ found: false });
        }
    } catch (err) {
        res.status(500).json({ error: "查詢出錯" });
    }
});

// 【後台匯入：讀取新欄位】
app.post('/api/admin/import-replace-date', upload.single('file'), (req, res) => {
    const password = req.headers['x-admin-password'];
    const mode = req.query.mode || 'append';
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    
    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const today = new Date().toISOString().split('T')[0];

        const runImport = db.transaction((rows) => {
            if (mode === 'replace') db.prepare('DELETE FROM users WHERE importDate = ?').run(today);
            const insertStmt = db.prepare('INSERT INTO users (name, phone, count, importDate, orderId, amount) VALUES (?, ?, ?, ?, ?, ?)');
            for (const row of rows) {
                const name = row.姓名 || row.name;
                let phone = String(row.手機 || row.phone || "").trim();
                const count = parseInt(row.抽獎次數 || 1);
                const orderId = row.訂單編號 || row.orderId || "無";
                const amount = row.金額 || row.amount || "0";

                if (name && phone) {
                    if (phone.length === 9 && phone.startsWith('9')) phone = '0' + phone;
                    insertStmt.run(name, phone, count, today, String(orderId), String(amount));
                }
            }
        });
        runImport(data);
        res.json({ ok: true, inserted: data.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.listen(process.env.PORT || 3000, "0.0.0.0");
