const http = require('http');
const { Client } = require('pg');
const url = require('url'); // URL解析用モジュール

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

let globalDbClient = null;

async function initDatabase() {
    if (!DATABASE_URL) return null;
    try {
        const client = new Client({
            connectionString: DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        await client.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS ranking (
                id SERIAL PRIMARY KEY,
                player_name VARCHAR(16) NOT NULL,
                clear_time REAL NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("[DB_SUCCESS] PostgreSQLに接続完了。");
        return client;
    } catch (err) {
        console.error("[DB_ERROR] DB接続失敗:", err);
        return null;
    }
}

const server = http.createServer(async (req, res) => {
    // URLのパラメータ（?name=...&time=...）を解析する
    const parsedUrl = url.parse(req.url, true);
    const query = parsedUrl.query;

    // 💡 ゲームからの送信（URLにnameとtimeが含まれている場合）
    if (query.name && query.time) {
        const playerName = String(query.name).trim();
        const clearTime = parseFloat(query.time);

        if (playerName.length > 0 && !isNaN(clearTime) && globalDbClient) {
            try {
                await globalDbClient.query(
                    "INSERT INTO ranking (player_name, clear_time) VALUES ($1, $2);",
                    [playerName, clearTime]
                );
                console.log(`[DB_SAVE] スコア保存成功!! -> ${playerName} | ${clearTime}秒`);
            } catch (err) {
                console.error("DBインサートエラー:", err);
            }
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end("OK");
        return;
    }

    // 💡 ブラウザからのアクセス（通常のランキングHTML表示）
    let rankingList = [];
    if (globalDbClient) {
        try {
            const dbRes = await globalDbClient.query("SELECT player_name, clear_time FROM ranking ORDER BY clear_time ASC LIMIT 10;");
            rankingList = dbRes.rows.map(row => ({ playerName: row.player_name, clearTime: row.clear_time }));
        } catch (err) {
            console.error("データ取得エラー:", err);
        }
    }

    let html = `<html><head><meta charset='utf-8'><title>Solo Ranking</title>
    <style>
        body { font-family: sans-serif; background: #f4f7f6; text-align: center; padding: 50px; }
        table { margin: 0 auto; border-collapse: collapse; background: #fff; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 400px; }
        th, td { padding: 12px 20px; border-bottom: 1px solid #ddd; }
        th { background: #2c3e50; color: #fff; }
        tr:nth-child(even) { background: #f9f9f9; }
        h1 { color: #2c3e50; }
    </style>
    </head><body><h1>Solo Play Ranking</h1><table><tr><th>Rank</th><th>Player</th><th>Time</th></tr>`;
    
    rankingList.forEach((item, index) => {
        html += `<tr><td>${index + 1}</td><td>${item.playerName}</td><td>${item.clearTime.toFixed(2)}s</td></tr>`;
    });
    html += `</table></body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(html);
});

(async () => {
    globalDbClient = await initDatabase();
    server.listen(PORT, () => {
        console.log(`[SERVER_START] ポート ${PORT} で待機中...`);
    });
})();
