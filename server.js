const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// ミドルウェア設定
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PostgreSQL 接続設定
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── データベース初期化（起動時に play_log カラムの存在を保証する） ──
async function initDB() {
    try {
        // テーブルがなければ作成
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scores (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                time REAL NOT NULL,
                play_log TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // カラムが途中で追加された場合のために自動で ALTER TABLE
        await pool.query(`
            ALTER TABLE scores ADD COLUMN IF NOT EXISTS play_log TEXT;
        `);

        console.log("Database initialized successfully with 'play_log' column.");
    } catch (err) {
        console.error("Failed to initialize database:", err);
    }
}
initDB();

// ── GET: スコア送信（C++ゲームクライアントからの受信用） ──
// URL例: /?name=Player&time=12.34&log=...
app.get('/', async (req, res, next) => {
    const { name, time, log } = req.query;

    // クエリパラメータに name と time がある場合は DB へ登録
    if (name && time) {
        try {
            const parsedTime = parseFloat(time);
            
            // ★ URLエンコードで '+' が ' ' (スペース) に変換されてしまう対策
            let playLog = log || '';
            if (playLog) {
                playLog = playLog.replace(/ /g, '+');
            }

            await pool.query(
                'INSERT INTO scores (name, time, play_log) VALUES ($1, $2, $3)',
                [name, parsedTime, playLog]
            );
            console.log(`[RECORD ADDED] Name: ${name}, Time: ${parsedTime}s, LogLength: ${playLog.length}`);
            
            // ★ DB登録成功時はレスポンスを返して終了（next()へ流さない）
            return res.status(200).send("OK: Score Saved");
        } catch (err) {
            console.error("データ登録エラー:", err);
            return res.status(500).send("Database Insert Error");
        }
    }

    // クエリが無い（通常のWebブラウザアクセス）場合は次のルート(HTML描画)へ
    next();
});

// ── API: ランキング取得 (JSON) ──
app.get('/api/scores', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT name, time, play_log, created_at FROM scores ORDER BY time ASC LIMIT 50'
        );
        res.json(result.rows);
    } catch (err) {
        console.error("データ取得エラー:", err);
        res.status(500).json({ error: err.message });
    }
});

// ── POST: ランキングリセット API ──
app.post('/api/reset', async (req, res) => {
    const { password } = req.body;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // 環境変数またはデフォルトパスワード

    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Invalid Password' });
    }

    try {
        await pool.query('DELETE FROM scores');
        console.log('[RANKING RESET] All records deleted by admin.');
        res.json({ success: true, message: 'All records have been reset.' });
    } catch (err) {
        console.error("リセットエラー:", err);
        res.status(500).json({ success: false, message: 'Database Reset Error' });
    }
});

// ── ランキング表示 HTML (ルートアクセス用) ──
app.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT name, time, play_log FROM scores ORDER BY time ASC LIMIT 50'
        );
        const scores = result.rows;

        let tableRows = '';
        if (scores.length === 0) {
            tableRows = `<tr><td colspan="4" style="text-align:center; padding: 20px; color: #888;">No records found. Play the game to set a record!</td></tr>`;
        } else {
            scores.forEach((row, index) => {
                const logStatus = row.play_log && row.play_log.length > 0 
                    ? `<span style="color:#2ecc71; font-weight:bold;">Available (${row.play_log.length} B)</span>` 
                    : `<span style="color:#95a5a6;">None</span>`;

                tableRows += `
                    <tr>
                        <td style="text-align:center;">${index + 1}</td>
                        <td><strong>${escapeHtml(row.name)}</strong></td>
                        <td style="text-align:right;">${row.time.toFixed(3)} s</td>
                        <td style="text-align:center;">${logStatus}</td>
                    </tr>
                `;
            });
        }

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Solo Play Ranking</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f9; margin: 0; padding: 40px 20px; color: #333; }
                .container { max-width: 700px; margin: 0 auto; }
                h1 { text-align: center; color: #2c3e50; margin-bottom: 5px; }
                p.sub { text-align: center; color: #7f8c8d; margin-top: 0; margin-bottom: 30px; }
                table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                th { background-color: #34495e; color: #fff; padding: 12px 15px; text-align: left; font-size: 14px; }
                td { padding: 12px 15px; border-bottom: 1px solid #ecf0f1; font-size: 14px; }
                tr:last-child td { border-bottom: none; }
                tr:nth-child(even) { background-color: #f8f9fa; }
                .reset-box { margin-top: 40px; background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border-top: 4px solid #e74c3c; text-align: center; }
                .reset-box h3 { margin-top: 0; color: #c0392b; }
                input[type="password"] { padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; width: 200px; }
                button { padding: 8px 16px; background-color: #e74c3c; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
                button:hover { background-color: #c0392b; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Solo Play Ranking</h1>
                <p class="sub">Game Score Board</p>

                <table>
                    <thead>
                        <tr>
                            <th style="width: 10%; text-align:center;">Rank</th>
                            <th style="width: 45%;">Player</th>
                            <th style="width: 25%; text-align:right;">Time</th>
                            <th style="width: 20%; text-align:center;">Log</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                    </tbody>
                </table>

                <div class="reset-box">
                    <h3>Reset Ranking</h3>
                    <input type="password" id="adminPass" placeholder="Enter Admin Password">
                    <button onclick="resetRanking()">RESET ALL</button>
                </div>
            </div>

            <script>
                async function resetRanking() {
                    const password = document.getElementById('adminPass').value;
                    if (!password) { alert('Please enter password'); return; }
                    
                    if (!confirm('Are you sure you want to delete all ranking data?')) return;

                    const res = await fetch('/api/reset', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password })
                    });
                    const data = await res.json();
                    if (data.success) {
                        alert(data.message);
                        location.reload();
                    } else {
                        alert('Error: ' + data.message);
                    }
                }
            </script>
        </body>
        </html>
        `;
        res.send(html);
    } catch (err) {
        console.error("HTML生成エラー:", err);
        res.status(500).send("Server Error");
    }
});

// HTMLエスケープヘルパー
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
