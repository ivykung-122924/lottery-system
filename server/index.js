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

// 2. 健康檢查
app.get('/health', (req, res) => res.status(200).send('OK'));

// 3. 【後台 API】讀取匯入日誌
app.get('/api/admin/logs', (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    try {
        const logs = db.prepare(`
            SELECT importDate, COUNT(*) as total 
            FROM users 
            GROUP BY importDate 
            ORDER BY importDate DESC
        `).all();
        res.json(logs);
    } catch (err) { res.status(500).json({ error: "讀取日誌失敗" }); }
});

// 4. 【前台 API】查詢功能
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

// 5. 【後台 API】匯入功能 (強化覆蓋邏輯)
app.post('/api/admin/import-replace-date', upload.single('file'), (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    if (!req.file) return res.status(400).json({ error: '未上傳檔案' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet);
        const today = new Date().toISOString().split('T')[0];
        let successCount = 0;

        const runImport = db.transaction((rows) => {
            // 獲取 Excel 中出現的所有日期並統格式化 (預防格式不一導致無法覆蓋)
            const datesInExcel = [...new Set(rows.map(r => String(r['日期'] || today).trim()))];

            // 如果模式是「覆蓋」，先刪除資料庫中與本次 Excel 相同日期的所有舊資料
            if (req.query.mode === 'replace') {
                const deleteStmt = db.prepare('DELETE FROM users WHERE importDate = ?');
                for (const d of datesInExcel) {
                    deleteStmt.run(d);
                }
            }
            
            const insertStmt = db.prepare('INSERT INTO users (name, phone, count, importDate, orderId, amount) VALUES (?, ?, ?, ?, ?, ?)');
            
            for (const row of rows) {
                const name = row['姓名'];
                let phone = String(row['電話'] || "").trim();
                const orderId = row['訂單編號'] || "無";
                const amount = row['金額'] || "0";
                const importDate = String(row['日期'] || today).trim();
                const count = parseInt(row['抽獎次數'] || 1);

                if (name && phone) {
                    // 電話補 0 邏輯
                    if (phone.length === 9 && phone.startsWith('9')) phone = '0' + phone;
                    
                    insertStmt.run(
                        String(name), 
                        phone, 
                        isNaN(count) ? 1 : count, 
                        importDate, 
                        String(orderId), 
                        String(amount)
                    );
                    successCount++;
                }
            }
        });

        runImport(data);
        res.json({ ok: true, inserted: successCount });
    } catch (err) {
        console.error("匯入錯誤:", err);
        res.status(500).json({ error: "匯入失敗，請確認 Excel 欄位名稱是否正確" });
    }
});

// 6. 頁面路由
app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

app.listen(process.env.PORT || 3000, "0.0.0.0");
