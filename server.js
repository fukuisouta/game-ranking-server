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

        // 1. ランキングテーブル作成
        await client.query(`
            CREATE TABLE IF NOT EXISTS ranking (
                id SERIAL PRIMARY KEY,
                player_name VARCHAR(16) NOT NULL,
                clear_time REAL NOT NULL,
                play_log TEXT, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. 掲示板用テーブル作成
        await client.query(`
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                author VARCHAR(16) NOT NULL,
                message VARCHAR(140) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("[DB_SUCCESS] PostgreSQLに接続完了 (ランキング & 掲示板)。");
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

    // ─── 1. 個別のプレイログ（Base64）を取得するAPI ───
    if (parsedUrl.pathname === '/get_log' && query.id) {
        const recordId = parseInt(query.id, 10);
        if (!isNaN(recordId) && globalDbClient) {
            try {
                const dbRes = await globalDbClient.query("SELECT play_log FROM ranking WHERE id = $1;", [recordId]);
                if (dbRes.rows.length > 0 && dbRes.rows[0].play_log) {
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end(dbRes.rows[0].play_log);
                    return;
                }
            } catch (err) {
                console.error("ログ取得エラー:", err);
            }
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end("Log Not Found");
        return;
    }

    // ─── 2. 掲示板の新規書き込み処理 (/post_comment) ───
    if (parsedUrl.pathname === '/post_comment' && req.method === 'GET') {
        const author = query.author ? String(query.author).trim() : 'Anonymous';
        const msg = query.message ? String(query.message).trim() : '';

        if (msg.length > 0 && globalDbClient) {
            try {
                await globalDbClient.query(
                    "INSERT INTO comments (author, message) VALUES ($1, $2);",
                    [author.substring(0, 16), msg.substring(0, 140)]
                );
                console.log(`[BBS_SAVE] コメント投稿完了: ${author} -> ${msg}`);
            } catch (err) {
                console.error("コメント投稿エラー:", err);
            }
        }
        res.writeHead(302, { 'Location': '/' });
        res.end();
        return;
    }

    // ─── 3. 掲示板の特定コメント削除処理 (/delete_comment) ───
    if (parsedUrl.pathname === '/delete_comment' && query.id) {
        const commentId = parseInt(query.id, 10);
        const inputPass = query.pass ? String(query.pass).trim() : '';

        // パスワード確認（ReoNa3150）
        if (inputPass === "ReoNa3150") {
            if (!isNaN(commentId) && globalDbClient) {
                try {
                    await globalDbClient.query("DELETE FROM comments WHERE id = $1;", [commentId]);
                    console.log(`[BBS_DELETE] コメントID:${commentId} を削除しました。`);
                } catch (err) {
                    console.error("コメント削除エラー:", err);
                }
            }
        }
        res.writeHead(302, { 'Location': '/' });
        res.end();
        return;
    }

    // ─── 4. パスワードによるランキングリセット処理 ───
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

    // ─── 5. ゲームクライアントからのスコア登録処理 ───
    if (query.name && query.time) {
        const playerName = String(query.name).trim();
        const clearTime = parseFloat(query.time);
        const playLog = query.log ? String(query.log).trim() : null;

        if (playerName.length > 0 && !isNaN(clearTime) && globalDbClient) {
            try {
                await globalDbClient.query(
                    "INSERT INTO ranking (player_name, clear_time, play_log) VALUES ($1, $2, $3);",
                    [playerName, clearTime, playLog]
                );
                console.log(`[DB_SAVE] スコア＆ログ保存成功!! -> ${playerName} | ${clearTime}秒`);
            } catch (err) {
                console.error("DBインサートエラー:", err);
            }
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end("OK");
        return;
    }

    // ─── 6. 最新データの取得 (ランキング & コメント) ───
    let rankingList = [];
    let commentList = [];

    if (globalDbClient) {
        try {
            // ランキング取得
            const dbRes = await globalDbClient.query("SELECT id, player_name, clear_time, play_log FROM ranking ORDER BY clear_time ASC LIMIT 1000;");
            rankingList = dbRes.rows.map(row => ({ 
                id: row.id,
                playerName: row.player_name, 
                clearTime: row.clear_time,
                hasLog: !!row.play_log
            }));

            // 掲示板コメント取得（idも一緒に取得）
            const bbsRes = await globalDbClient.query("SELECT id, author, message, created_at FROM comments ORDER BY id DESC LIMIT 50;");
            commentList = bbsRes.rows.map(row => ({
                id: row.id,
                author: row.author,
                message: row.message,
                time: new Date(row.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
            }));

        } catch (err) {
            console.error("データ取得エラー:", err);
        }
    }

    // JSONでランキング要求された場合
    if (query.format === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rankingList));
        return;
    }

    // メッセージ表示HTML
    let messageHtml = "";
    if (message) {
        const color = isError ? "#e74c3c" : "#2ecc71";
        messageHtml = `<div style='background: ${color}; color: #fff; padding: 12px; margin-bottom: 20px; border-radius: 4px; font-weight: bold; max-width: 480px; margin-left: auto; margin-right: auto; box-shadow: 0 2px 4px rgba(0,0,0,0.1);'>${message}</div>`;
    }

    // ─── 7. HTMLソースコード作成 ───
    let html = `<!DOCTYPE html><html><head><meta charset='utf-8'><title>Ranking & BBS</title>
    <style>
        body { font-family: sans-serif; background: #f4f7f6; text-align: center; padding: 40px 20px; color: #2c3e50; }
        table { margin: 0 auto 30px auto; border-collapse: collapse; background: #fff; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 100%; max-width: 480px; }
        th, td { padding: 12px 20px; border-bottom: 1px solid #ddd; }
        th { background: #2c3e50; color: #fff; }
        tr:nth-child(even) { background: #f9f9f9; }
        h1 { margin-bottom: 5px; color: #2c3e50; }
        h2 { font-size: 16px; color: #7f8c8d; margin-top: 0; margin-bottom: 20px; }
        .log-btn { background: #3498db; color: white; padding: 4px 8px; border-radius: 4px; text-decoration: none; font-size: 12px; }
        .log-btn:hover { background: #2980b9; }

        /* お知らせスタイル */
        .notice-box {
            background: #fff; border-left: 5px solid #e67e22; padding: 15px 20px;
            margin: 0 auto 25px auto; max-width: 480px; text-align: left;
            border-radius: 4px; box-shadow: 0 2px 5px rgba(0,0,0,0.08);
        }
        .notice-title { font-weight: bold; color: #d35400; font-size: 14px; margin-bottom: 6px; }
        .notice-body { font-size: 13px; color: #555; line-height: 1.5; }

        /* 掲示板スタイル */
        .bbs-container {
            background: #fff; max-width: 480px; margin: 40px auto 30px auto;
            padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); text-align: left;
        }
        .bbs-container h3 { margin-top: 0; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 8px; }
        .bbs-form input[type='text'] { padding: 8px; border: 1px solid #ccc; border-radius: 4px; margin-bottom: 10px; font-size: 13px; }
        .bbs-form .input-author { width: 140px; display: block; }
        .bbs-form .input-msg { width: 95%; display: block; }
        .bbs-form input[type='submit'] { background: #3498db; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; }
        .bbs-form input[type='submit']:hover { background: #2980b9; }
        
        .comment-item { border-bottom: 1px solid #eee; padding: 10px 0; position: relative; }
        .comment-item:last-child { border-bottom: none; }
        .comment-header { font-size: 12px; color: #7f8c8d; margin-bottom: 4px; }
        .comment-author { font-weight: bold; color: #2c3e50; font-size: 13px; }
        .comment-body { font-size: 14px; color: #333; word-break: break-all; padding-right: 40px; }
        
        /* 🗑️ 削除ボタン用の装飾 */
        .del-btn {
            position: absolute; right: 0; top: 10px;
            color: #e74c3c; font-size: 11px; text-decoration: none;
            border: 1px solid #e74c3c; padding: 2px 6px; border-radius: 3px;
            background: #fff;
        }
        .del-btn:hover { background: #e74c3c; color: #fff; }

        /* 管理者パネル */
        .admin-panel { background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 100%; max-width: 360px; margin: 0 auto; border-top: 4px solid #e74c3c; }
        input[type='password'] { padding: 8px; width: 180px; margin-right: 10px; border: 1px solid #ccc; border-radius: 4px; }
        .btn-reset { padding: 8px 16px; background: #e74c3c; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
        .btn-reset:hover { background: #c0392b; }
    </style>
    <script>
        // 削除ボタンを押したときにパスワード入力を求めるJavaScript
        function deleteComment(id) {
            var pass = prompt("削除用管理者パスワードを入力してください:");
            if (pass) {
                window.location.href = "/delete_comment?id=" + id + "&pass=" + encodeURIComponent(pass);
            }
        }
    </script>
    </head><body>
    <h1> Ranking</h1>
    <h2>Game Score Board</h2>

    <!-- 📢 お知らせ -->
    <div class='notice-box'>
        <div class='notice-title'>⚠️ システム不具合に関するお詫びとお知らせ</div>
        <div class='notice-body'>
            サーバーアップデートに伴う障害により、一時的にランキング機能が利用できない状態が発生しておりました。<br>
            ご利用の皆様には大変ご迷惑をおかけしましたことを深くお詫び申し上げます。<br>
            現在は復旧し、正常に記録されるようになっております。
        </div>
    </div>

    ${messageHtml}

    <!-- 🏆 ランキングテーブル -->
    <table><tr><th>Rank</th><th>Player</th><th>Time</th><th>Log</th></tr>`;
    
    if (rankingList.length === 0) {
        html += `<tr><td colspan='4' style='color:#7f8c8d; padding: 20px;'>No records found. Play the game to set a record!</td></tr>`;
    } else {
        rankingList.forEach((item, index) => {
            const logCell = item.hasLog 
                ? `<a class='log-btn' href='/get_log?id=${item.id}' target='_blank'>Download</a>` 
                : `<span style='color:#ccc;'>None</span>`;

            html += `<tr><td>${index + 1}</td><td>${escapeHtml(item.playerName)}</td><td>${item.clearTime.toFixed(2)}s</td><td>${logCell}</td></tr>`;
        });
    }
    html += `</table>`;

    // ─── 💬 掲示板セクション ───
    html += `
    <div class='bbs-container'>
        <h3>💬掲示板</h3>
        <form class='bbs-form' action='/post_comment' method='get'>
            <input type='text' name='author' class='input-author' placeholder='Name (名前)' maxlength='16' required>
            <input type='text' name='message' class='input-msg' placeholder='Leave a message... (コメントを書く)' maxlength='140' required>
            <input type='submit' value='POST (投稿)'>
        </form>
        <hr style='border: none; border-top: 1px solid #eee; margin: 20px 0;'>
        <div class='comment-list'>`;

    if (commentList.length === 0) {
        html += `<div style='color:#7f8c8d; font-size: 13px;'>No comments yet.</div>`;
    } else {
        commentList.forEach(c => {
            html += `
            <div class='comment-item'>
                <a href='javascript:void(0);' class='del-btn' onclick='deleteComment(${c.id})'>削除</a>
                <div class='comment-header'>
                    <span class='comment-author'>${escapeHtml(c.author)}</span> • <span>${c.time}</span>
                </div>
                <div class='comment-body'>${escapeHtml(c.message)}</div>
            </div>`;
        });
    }

    html += `
        </div>
    </div>`;

    // 🔒 管理者用リセットフォーム
    html += `
    <div class='admin-panel'>
        <h3 style='margin-top:0;'>Reset Ranking</h3>
        <form action='/' method='get'>
            <input type='password' name='password' placeholder='Enter Admin Password' required>
            <input type='submit' class='btn-reset' value='RESET ALL'>
        </form>
    </div>
    </body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(html);
});

// XSS（スクリプトインジェクション）対策用エスケープ関数
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// データベースのセットアップ後にサーバーを起動
(async () => {
    globalDbClient = await initDatabase();
    server.listen(PORT, () => {
        console.log(`[SERVER_START] ポート ${PORT} で待機中...`);
    });
})();
