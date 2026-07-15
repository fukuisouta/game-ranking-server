const http = require('http');
const { Client } = require('pg');
const url = require('url');

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

let globalDbClient = null;

// PostgreSQLデータベースの接続設定とテーブル作成
async function initDatabase() {
    if (!DATABASE_URL) return null;
    try {
        const client = new Client({
            connectionString: DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        await client.connect();
        
        // ランキング保存用のテーブルがなければ作成（初期レコードは挿入しない）
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

// データベースの全スコアを物理削除して完全リセットする
async function resetDatabase() {
    if (!globalDbClient) return false;
    try {
        // テーブルを空にしてIDの連番も1にリセット
        await globalDbClient.query("TRUNCATE TABLE ranking RESTART IDENTITY;");
        console.log("[DB_RESET] データベースランキングを完全に初期化しました。");
        return true;
    } catch (err) {
        console.error("[DB_RESET_ERROR] リセット失敗:", err);
        return false;
    }
}

// サーバーにリクエストが届いたときの処理
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const query = parsedUrl.query;

    let message = "";
    let isError = false;

    // 1. パスワード（ReoNa3150）によるランキングリセット処理
    if (query.password !== undefined) {
        if (query.password === "ReoNa3150") {
            const success = await resetDatabase();
            if (success) {
                message = "Ranking successfully reset!";
                isError = false;
            } else {
                message = "Database reset failed. Check server logs.";
                isError = true;
            }
        } else {
            message = "Invalid admin password.";
            isError = true;
            console.log(`[RESET_FAILED] パスワード不一致: ${query.password}`);
        }
    }

    // 2. ゲームクライアントからのスコア登録処理（?name=名前&time=タイム）
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

    // 3. 最新のランキングデータをデータベースから取得する（タイム昇順）
    let rankingList = [];
    if (globalDbClient) {
        try {
            const dbRes = await globalDbClient.query("SELECT player_name, clear_time FROM ranking ORDER BY clear_time ASC LIMIT 1000;");
            rankingList = dbRes.rows.map(row => ({ playerName: row.player_name, clearTime: row.clear_time }));
        } catch (err) {
            console.error("データ取得エラー:", err);
        }
    }

    // リセット結果を通知するメッセージ（成功なら緑、失敗なら赤）のHTMLを組み立て
    let messageHtml = "";
    if (message) {
        const color = isError ? "#e74c3c" : "#2ecc71";
        messageHtml = `<div style='background: ${color}; color: #fff; padding: 12px; margin-bottom: 20px; border-radius: 4px; font-weight: bold; max-width: 400px; margin-left: auto; margin-right: auto; box-shadow: 0 2px 4px rgba(0,0,0,0.1);'>${message}</div>`;
    }

    // 表示するWebページのHTMLソースコードの作成
    let html = `<html><head><meta charset='utf-8'><title>Solo Ranking</title>
    <style>
        body { font-family: sans-serif; background: #f4f7f6; text-align: center; padding: 50px; color: #2c3e50; }
        table { margin: 0 auto 30px auto; border-collapse: collapse; background: #fff; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 400px; }
        th, td { padding: 12px 20px; border-bottom: 1px solid #ddd; }
        th { background: #2c3e50; color: #fff; }
        tr:nth-child(even) { background: #f9f9f9; }
        .admin-panel { background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 360px; margin: 0 auto; border-top: 4px solid #e74c3c; }
        input[type='password'] { padding: 8px; width: 180px; margin-right: 10px; border: 1px solid #ccc; border-radius: 4px; }
        input[type='submit'] { padding: 8px 16px; background: #e74c3c; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
        input[type='submit']:hover { background: #c0392b; }
        h1 { margin-bottom: 5px; color: #2c3e50; }
        h2 { font-size: 16px; color: #7f8c8d; margin-top: 0; margin-bottom: 25px; }
    </style>
    </head><body>
    <h1>Solo Play Ranking</h1>
    <h2>Game Score Board</h2>
    ${messageHtml}
    <table><tr><th>Rank</th><th>Player</th><th>Time</th></tr>`;
    
    // データが空のとき、またはランキングが存在するときで表示を分岐
    if (rankingList.length === 0) {
        html += `<tr><td colspan='3' style='color:#7f8c8d; padding: 20px;'>No records found. Play the game to set a record!</td></tr>`;
    } else {
        rankingList.forEach((item, index) => {
            html += `<tr><td>${index + 1}</td><td>${item.playerName}</td><td>${item.clearTime.toFixed(2)}s</td></tr>`;
        });
    }

    // パスワード送信用のフォーム
    html += `</table>
    <div class='admin-panel'>
        <h3>Reset Ranking</h3>
        <form action='/' method='get'>
            <input type='password' name='password' placeholder='Enter Admin Password' required>
            <input type='submit' value='RESET ALL'>
        </form>
    </div>
    </body></html>`;

    // 完成したHTMLをブラウザに返却
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(html);
});

// データベースのセットアップ後にサーバーを起動
(async () => {
    globalDbClient = await initDatabase();
    server.listen(PORT, () => {
        console.log(`[SERVER_START] ポート ${PORT} で待機中...`);
    });
})();
