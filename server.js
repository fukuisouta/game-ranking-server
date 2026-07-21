const express = require('express');
const cors = require('cors');
const { Client } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

// ミドルウェアの設定（CORS許可・JSON解析・URLエンコード解析）
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

let globalDbClient = null;

// PostgreSQL データベースの接続設定とテーブル作成
async function initDatabase() {
    if (!DATABASE_URL) {
        console.error("[DB_ERROR] DATABASE_URL が設定されていません。");
        return null;
    }
    try {
        const client = new Client({
            connectionString: DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        await client.connect();

        // ログ (log_data) も保存できるように COLUMN を定義
        await client.query(`
            CREATE TABLE IF NOT EXISTS ranking (
                id SERIAL PRIMARY KEY,
                player_name VARCHAR(64) NOT NULL,
                clear_time REAL NOT NULL,
                log_data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("[DB_SUCCESS] PostgreSQLに正常接続＆テーブル準備完了。");
        return client;
    } catch (err) {
        console.error("[DB_ERROR] DB接続失敗:", err);
        return null;
    }
}

// データベースの全スコアを物理削除して完全リセットする関数の定義
async function resetDatabase() {
    if (!globalDbClient) return false;
    try {
        await globalDbClient.query("TRUNCATE TABLE ranking RESTART IDENTITY;");
        console.log("[DB_RESET] データベースランキングを完全に初期化しました。");
        return true;
    } catch (err) {
        console.error("[DB_RESET_ERROR] リセット失敗:", err);
        return false;
    }
}

// ============================================================
// 🚀 1. C++ ゲームからの JSON POST スコア送信エンドポイント
// ============================================================
app.post('/api/score', async (req, res) => {
    try {
        const { name, time, log } = req.body;
        const playerName = String(name || 'Unknown').trim();
        const clearTime = parseFloat(time);
        const logData = log || '';

        if (playerName.length > 0 && !isNaN(clearTime) && globalDbClient) {
            await globalDbClient.query(
                "INSERT INTO ranking (player_name, clear_time, log_data) VALUES ($1, $2, $3);",
                [playerName, clearTime, logData]
            );
            console.log(`[DB_SAVE] スコア保存成功! -> ${playerName} | ${clearTime}秒`);
            return res.json({ success: true, message: "OK: Score Saved" });
        } else {
            return res.status(400).json({ success: false, message: "Invalid payload or DB offline" });
        }
    } catch (err) {
        console.error("[POST_ERROR] スコア保存例外エラー:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 🌐 2. Web画面表示 ＆ 管理者リセット & GETパラメータ登録
// ============================================================
app.get('/', async (req, res) => {
    const query = req.query;
    let message = "";
    let isError = false;

    // ① パスワードによるランキングリセット処理
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
        }
    }

    // ② GETパラメータによる直接スコア登録 (バックアップ用)
    if (query.name && query.time) {
        const playerName = String(query.name).trim();
        const clearTime = parseFloat(query.time);

        if (playerName.length > 0 && !isNaN(clearTime) && globalDbClient) {
            try {
                await globalDbClient.query(
                    "INSERT INTO ranking (player_name, clear_time) VALUES ($1, $2);",
                    [playerName, clearTime]
                );
                console.log(`[DB_SAVE_GET] GETスコア保存成功 -> ${playerName} | ${clearTime}秒`);
            } catch (err) {
                console.error("DBインサートエラー:", err);
            }
        }
        return res.send("OK");
    }

    // ③ ランキング一覧データの取得（タイム昇順）
    let rankingList = [];
    if (globalDbClient) {
        try {
            const dbRes = await globalDbClient.query("SELECT player_name, clear_time, log_data FROM ranking ORDER BY clear_time ASC LIMIT 1000;");
            rankingList = dbRes.rows.map(row => ({
                playerName: row.player_name,
                clearTime: row.clear_time,
                logData: row.log_data || ""
            }));
        } catch (err) {
            console.error("データ取得エラー:", err);
        }
    }

    // HTMLメッセージ枠の組み立て
    let messageHtml = "";
    if (message) {
        const color = isError ? "#e74c3c" : "#2ecc71";
        messageHtml = `<div style='background: ${color}; color: #fff; padding: 12px; margin-bottom: 20px; border-radius: 4px; font-weight: bold; max-width: 500px; margin: 0 auto 20px auto; box-shadow: 0 2px 4px rgba(0,0,0,0.1);'>${message}</div>`;
    }

    // レスポンスHTMLの組み立て
    let html = `<!DOCTYPE html><html><head><meta charset='utf-8'><title>Solo Ranking</title>
    <style>
        body { font-family: sans-serif; background: #f4f7f6; text-align: center; padding: 50px 20px; color: #2c3e50; }
        table { margin: 0 auto 30px auto; border-collapse: collapse; background: #fff; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 100%; max-width: 650px; }
        th, td { padding: 12px 15px; border-bottom: 1px solid #ddd; text-align: center; }
        th { background: #2c3e50; color: #fff; }
        tr:nth-child(even) { background: #f9f9f9; }
        .admin-panel { background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 100%; max-width: 360px; margin: 0 auto; border-top: 4px solid #e74c3c; }
        input[type='password'] { padding: 8px; width: 180px; margin-right: 10px; border: 1px solid #ccc; border-radius: 4px; }
        input[type='submit'] { padding: 8px 16px; background: #e74c3c; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
        input[type='submit']:hover { background: #c0392b; }
        h1 { margin-bottom: 5px; color: #2c3e50; }
        h2 { font-size: 16px; color: #7f8c8d; margin-top: 0; margin-bottom: 25px; }
        
        /* ログアコーディオン表示用 */
        details { text-align: left; background: #272822; color: #f8f8f2; padding: 8px; border-radius: 4px; margin-top: 5px; }
        summary { cursor: pointer; color: #a6e22e; font-weight: bold; }
        pre { font-family: monospace; font-size: 11px; white-space: pre-wrap; margin: 5px 0 0 0; }
    </style>
    </head><body>
    <h1>Solo Play Ranking</h1>
    <h2>Game Score Board</h2>
    ${messageHtml}
    <table><tr><th>Rank</th><th>Player</th><th>Time</th><th>Log</th></tr>`;

    if (rankingList.length === 0) {
        html += `<tr><td colspan='4' style='color:#7f8c8d; padding: 20px;'>No records found. Play the game to set a record!</td></tr>`;
    } else {
        rankingList.forEach((item, index) => {
            const logView = item.logData ?
                `<details><summary>View Log</summary><pre>${item.logData.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre></details>` :
                `<span style="color:#ccc;">No Log</span>`;

            html += `<tr>
                <td>${index + 1}</td>
                <td>${item.playerName}</td>
                <td>${item.clearTime.toFixed(2)}s</td>
                <td style="max-width:220px;">${logView}</td>
            </tr>`;
        });
    }

    html += `</table>
    <div class='admin-panel'>
        <h3>Reset Ranking</h3>
        <form action='/' method='get'>
            <input type='password' name='password' placeholder='Enter Admin Password' required>
            <input type='submit' value='RESET ALL'>
        </form>
    </div>
    </body></html>`;

    res.send(html);
});

// データベース接続後にサーバー起動
(async () => {
    globalDbClient = await initDatabase();
    app.listen(PORT, () => {
        console.log(`[SERVER_START] Expressサーバーがポート ${PORT} で起動しました。`);
    });
})();
