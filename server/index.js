const express = require('express');
const path = require('path');
const app = express();

// Railway 健康檢查
app.get('/health', (req, res) => res.status(200).send('OK'));

// 強制解析 public 資料夾路徑
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// 設定後台路由
app.get('/admin', (req, res) => {
    res.sendFile(path.join(publicPath, 'admin.html'));
});

// 設定前台路由
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`伺服器已啟動：${PORT}`);
});
