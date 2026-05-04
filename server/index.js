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
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, count INTEGER, importDate TEXT)`);

app.use(express.json());
app.use(express.static(publicPath));
const upload = multer({ storage: multer.memoryStorage() });

app.get('/health', (req, res) => res.status(200).send('OK'));

// 【修正重點：前台查詢 API】
app.get('/api/check', (req, res) => {
    try {
        const phone = req.query.phone;
        if (!phone) return res.json({ found: false });
        
        // 增加防錯：先確認是否有這筆電話，再進行 SUM
        const check = db.prepare('SELECT name FROM users WHERE phone = ? LIMIT 1').get(phone);
        
        if (check) {
            const row = db.prepare('SELECT SUM(count) as total FROM users WHERE phone = ?').get(phone);
            res.json({ found: true, name: check.name, count: row.total || 0 });
        } else {
            res.json({ found: false });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "伺服器查詢錯誤" });
    }
});

app.get('/api/admin/list', (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    res.json(db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 50').all());
});

app.post('/api/admin/import-replace-date', upload.single('file'), (req, res) => {
    const password = req.headers['x-admin-password'];
    const mode = req.query.mode || 'append';
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    if (!req.file) return res.status(400).json({ error: '未上傳檔案' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const today = new Date().toISOString().split('T')[0];

        const runImport = db.transaction((rows) => {
            if (mode === 'replace') db.prepare('DELETE FROM users WHERE importDate = ?').run(today);
            const insertStmt = db.prepare('INSERT INTO users (name, phone, count, importDate) VALUES (?, ?, ?, ?)');
            for (const row of rows) {
                const name = row.姓名 || row.Name || row.name;
                let phone = row.手機 || row.Phone || row.phone || row.電話;
                let count = parseInt(row.抽獎次數 || row.count || 1);
                if (name && phone) {
                    phone = String(phone).trim();
                    if (phone.length === 9 && phone.startsWith('9')) phone = '0' + phone;
                    insertStmt.run(name, phone, isNaN(count) ? 1 : count, today);
                }
            }
        });
        runImport(data);
        res.json({ ok: true, inserted: data.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Running on ${PORT}`));
