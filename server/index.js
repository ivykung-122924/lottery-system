const express = require('express');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const fs = require('fs');
const app = express();

// 1. 自動路徑偵測
let publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    publicPath = path.join(__dirname, '..', 'public');
}

// 2. 資料庫初始化 (包含所有必要欄位)
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

// 3. Railway 健康檢查
app.get('/health', (req, res) => res.status(200).send('OK'));

// --- API 路由區 ---

// 【前台查詢】顯示總次數與訂單明細
app.get('/api/check', (req, res) => {
    try {
        const phone = String(req.query.phone || "").trim();
        if (!phone) return res.json({ found: false });
        
        const details = db.prepare('SELECT * FROM users WHERE phone = ?').all(phone);
        if (details.length > 0) {
            const totalCount = details.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
            res.json({ found: true, name: details[0].name, totalCount: totalCount, details: details });
        } else {
            res.json({ found: false });
        }
    } catch (err) { 
        console.error("查詢報錯:", err);
        res.status(500).json({ error: "查詢出錯" }); 
    }
});

// 【後台專用】讀取所有已上傳資料清單 (你缺少的內容在這裡)
app.get('/api/admin/list', (req, res) => {
    const password = req.headers['x-admin-password'];
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    
    try {
        // 抓取所有資料，讓最新匯入的排在最前面
        const rows = db.prepare('SELECT * FROM users ORDER BY id DESC').all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "讀取清單失敗" });
    }
});

// 【後台匯入】支援追加與今日資料替換
app.post('/api/admin/import-replace-date', upload.single('file'), (req, res) => {
    const password = req.headers['x-admin-password'];
    const mode = req.query.mode || 'append';
    if (password !== '123456') return res.status(403).json({ error: '密碼錯誤' });
    if (!req.file) return res.status(400).json({ error: '未上傳檔案' });
    
    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const today = new Date().toISOString().split('T')[0];
        let successCount = 0;

        const runImport = db.transaction((rows) => {
            if (mode === 'replace') {
                db.prepare('DELETE FROM users WHERE importDate = ?').run(today);
            }
            
            const insertStmt = db.prepare('INSERT INTO users (name, phone, count, importDate, orderId, amount) VALUES (?, ?, ?, ?, ?, ?)');
            
            for (const row of rows) {
                const name = row.姓名 || row.客戶姓名 || row.name || row.Name;
                let phone = String(row.手機 || row.電話 || row.phone || row.Phone || "").trim();
                const count = parseInt(row.抽獎次數 || row.次數 || row.count || 1);
                const orderId = row.訂單編號 || row.訂單 || row.orderId || "無";
                const amount = row.金額 || row.總額 || row.amount || "0";

                if (name && phone) {
                    if (phone.length === 9 && phone.startsWith('9')) phone = '0' + phone;
                    insertStmt.run(name, phone, isNaN(count) ? 1 : count, today, String(orderId), String(amount));
                    successCount++;
                }
            }
        });
        
        runImport(data);
        res.json({ ok: true, inserted: successCount, totalInFile: data.length });
    } catch (err) { 
        console.error("匯入失敗原因:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// 頁面路由
app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// 啟動監聽
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 抽獎系統伺服器已啟動: Port ${PORT}`);
});
